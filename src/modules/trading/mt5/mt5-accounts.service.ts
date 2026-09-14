import { Inject, Injectable, Logger } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import Decimal from 'decimal.js';
import { and, eq, ne, sql } from 'drizzle-orm';
import { DRIZZLE_DB } from '../../../database/database.module';
import type { Db } from '../../../database/db';
import { tradingAccounts, users } from '../../../database/schema';
import { Mt5BridgeClient } from './mt5-bridge.client';
import { AdminAuditService } from '../../admin/admin-audit.service';
import { EmailService } from '../../email/email.service';
import { assertActorCan } from '../../../common/security/actor';
import { maskedFieldsFor } from '../../../common/security/field-mask';
import { clientScopePredicate } from '../../../common/security/client-scope';
import type { AuthenticatedAdmin } from '../../admin/guards/admin.guard';
import {
  AccountNameTakenError,
  NotFoundError,
  ValidationError,
} from '../../../common/errors/domain-errors';
import { AppSettingsStore } from '../../../store/app-settings.store';
import { ProductsStore } from '../../../store/products.store';
import { Mt5AccountSyncService } from './mt5-account-sync.service';
import { tradingTermsFrom } from '../../../common/trading-terms';
import {
  NOTIFICATION_DISPATCH,
  type NotificationDispatchPort,
} from '../../../common/provisioning/notification-dispatch.port';

/**
 * Clamp demo funding to the configured ceiling.
 *
 * Capped rather than refused, so a fat-fingered extra zero still produces a
 * working account. The ceiling itself is an operator setting — see
 * `trading_settings` — because "how much practice money is useful practice" is
 * a commercial judgement, and it lived here as a constant compiled into two
 * apps for far too long.
 */
function capDemoFunding(amount: string, ceiling: string): string {
  // Parsed ONLY to compare against the cap. The string is what is sent onward
  // when it is within range, so nothing that reaches MT5 has been through a
  // float unless it had to be.
  return Number.parseFloat(amount) > Number.parseFloat(ceiling) ? ceiling : amount;
}

/**
 * Opening MT5 accounts and moving their balances, from the back office.
 *
 * ## Why this is not in AdminHoldingsService
 *
 * That one reads `trading_accounts` — our own table, one database, no network.
 * Everything here crosses to a server we do not own, over a bridge that can
 * time out, and each method has to answer "what is true if the far side
 * succeeded and we never heard". Mixing the two would put that question in a
 * file where most methods do not have it.
 *
 ## Credentials are emailed, never returned
 *
 * Neither create method puts a password in its response. MT5 issues them once
 * and nothing stores them, so the mail to the client is the only copy that will
 * ever exist — see `tradingAccountOpened`. A response carrying them would be
 * read by whoever pressed the button, which on the admin path is staff.
 *
 * ## MT5 is the source of truth for balance; we are for identity
 *
 * The `balance` column on `trading_accounts` is a CACHE. MT5 owns the real
 * number — a client's own trading moves it every second and nothing tells us —
 * so this service refreshes the cache opportunistically and never treats it as
 * authoritative. `GET /admin/trading-accounts/:id/live` is the honest read.
 */
@Injectable()
export class Mt5AccountsService {
  private readonly logger = new Logger(Mt5AccountsService.name);

  constructor(
    @Inject(DRIZZLE_DB) private readonly db: Db,
    private readonly bridge: Mt5BridgeClient,
    private readonly audit: AdminAuditService,
    private readonly email: EmailService,
    private readonly settings: AppSettingsStore,
    /*
     * The TOKEN from `common/`, not `NotificationsService` — the port recipe
     * every domain module here follows, and `NotificationsModule` is `@Global`
     * so this needs no import to resolve. Required rather than optional: unlike
     * `AuthService`, nothing hand-constructs this service.
     */
    @Inject(NOTIFICATION_DISPATCH)
    private readonly notifications: NotificationDispatchPort,
    /*
     * The catalogue, read once per create to snapshot `product_id` (0080).
     *
     * A STORE rather than `CatalogueService`, and that is not a style choice:
     * `CatalogueService` already depends on THIS service, so injecting it back
     * would close a cycle. `ProductsStore` lives in the `@Global()` StoreModule,
     * depends on nothing but the db, and is the read half both sides share.
     *
     * APPENDED LAST, matching `SelfServiceGroups` — a constructor argument
     * inserted in the middle silently re-binds every positional construction in
     * the specs.
     */
    private readonly products: ProductsStore,
    /*
     * The mirror's only writer, shared with the bridge's pushed snapshots so
     * both go through the same staleness guard. APPENDED LAST, as above.
     */
    private readonly accountSync: Mt5AccountSyncService,
  ) {}

  /**
   * The product a group is being sold as, at the moment an account opens in it.
   *
   * Wrapped rather than called inline because it must NEVER fail a create. The
   * account already exists on the broker's server by the time this runs — the
   * insert is the last step, deliberately, per the ordering note on
   * `createAccount` — so throwing here would abandon a real MT5 account with no
   * row pointing at it, which is the exact failure that ordering exists to
   * avoid. A product label is not worth that.
   *
   * A miss and a failure both store NULL, and NULL already means "no product",
   * which the portal renders by omitting the row. The difference is that a
   * failure is logged with the group named, so it can be set by hand.
   */
  private async productForGroup(group: string): Promise<string | null> {
    try {
      return await this.products.productIdForGroup(group);
    } catch (error) {
      this.logger.error(
        `Could not resolve the product for group ${group}; the account is being opened with ` +
          `no product recorded. ${error instanceof Error ? error.message : String(error)}`,
      );
      return null;
    }
  }

  /**
   * The operator's trading terms, read fresh on each create.
   *
   * Not cached. A create is already several network round trips to the broker,
   * so one indexed read of a single-row table costs nothing measurable — and an
   * operator who lowers a cap because of an abuse incident should not have to
   * wait out a TTL or restart the process for it to take effect.
   */
  private async terms() {
    return tradingTermsFrom(await this.settings.getTrading());
  }

  /**
   * Groups straight from MT5, for the CLIENT-facing options endpoint.
   *
   * No actor and no permission check, unlike `listGroups` below, and the
   * difference is what it is used for: that one hands an operator the broker's
   * whole group structure to choose from, which is internal. This is called
   * only to look up the CURRENCY of groups the broker has already decided to
   * advertise, and the caller discards everything else.
   */
  async listGroupsForClients() {
    this.assertBridge();
    return await this.bridge.listGroups();
  }

  /** The groups an account may be opened in, straight from MT5. */
  async listGroups(actor: AuthenticatedAdmin) {
    assertActorCan(actor, 'trading.create', 'list MT5 groups');
    this.assertBridge();
    return await this.bridge.listGroups();
  }

  /**
   * Open an account on MT5 and record it against a client.
   *
   * ## Order matters, and this order is deliberate
   *
   * MT5 first, our row second. The reverse — insert locally, then call the
   * bridge — leaves a `trading_accounts` row with no `login` when the bridge
   * fails, and that row is indistinguishable from an account that exists on a
   * server we could not reach. This way a bridge failure leaves NOTHING behind
   * and the operator simply tries again.
   *
   * The cost is the opposite gap: MT5 creates the account, our insert fails,
   * and an orphan exists on the broker's server that the CRM does not know
   * about. That is recoverable by hand and the other is not — an orphan is
   * visible in the manager terminal, whereas a local row pointing at nothing
   * looks exactly like a working account until somebody tries to trade on it.
   */
  async createAccount(
    input: {
      userId: string;
      group: string;
      leverage?: number;
      environment: 'live' | 'demo';
    },
    actor: AuthenticatedAdmin,
  ) {
    assertActorCan(actor, 'trading.create', 'open a trading account');

    /*
     * Visibility BEFORE the bridge. The territory predicate joins the WHERE, so
     * a scoped admin opening an account for a client OUTSIDE their tags gets no
     * row and the same 404 as a client that does not exist (D-45: never
     * fetch-then-filter, never a distinguishable 403 that would confirm the
     * client banks here). This was MISSING — the route declared itself scoped
     * and enforced nothing, so a scoped desk with `trading.create` could open a
     * real live MT5 account for any client and get their email back in
     * `credentialsSentTo`. Resolved before `assertBridge()` because "not your
     * client" is true whether or not MT5 is reachable.
     */
    const [client] = await this.db
      .select({
        id: users.id,
        email: users.email,
        firstName: users.firstName,
        lastName: users.lastName,
        country: users.country,
        phone: users.phone,
      })
      .from(users)
      .where(and(eq(users.id, input.userId), clientScopePredicate(actor.clientScope, users.id)))
      .limit(1);

    if (!client) throw new NotFoundError('Client not found.');
    this.assertBridge();

    const created = await this.bridge.createAccount({
      group: input.group,
      name: `${client.firstName} ${client.lastName}`.trim(),
      email: client.email,
      country: client.country ?? undefined,
      phone: client.phone ?? undefined,
      leverage: input.leverage,
      // Our id in MT5's comment field, so a row on either side resolves to the
      // other. MT5 has no foreign keys and no custom columns.
      externalId: client.id,
    });

    const [row] = await this.db
      .insert(tradingAccounts)
      .values({
        userId: client.id,
        login: String(created.login),
        /*
         * THE GROUP, and it was missing.
         *
         * Every account opened through here stored NULL, so `mt5_group` was
         * empty for the entire estate — and the portal's account card, which
         * renders it, showed an em dash to every client on every account.
         *
         * It is not only a label. `trading_product_groups` is UNIQUE on
         * `mt5_group` precisely so that "which product is this account under"
         * has an answer, and its schema comment says why that question matters:
         * it decides whose commission the account pays. With this column null
         * the question was unanswerable for every account in the system.
         *
         * `created.group` rather than `input.group` — what MT5 actually put the
         * account in, read back from the bridge's own response. The two are
         * normally the same string; when they are not, the server is right and
         * we are not, and storing what we ASKED for would record a group the
         * account is not in.
         */
        mt5Group: created.group,
        /*
         * THE PRODUCT, snapshotted (0080).
         *
         * Resolved from the group MT5 confirmed, not the one requested — same
         * reasoning as `mt5Group` directly above: if the server put the account
         * somewhere else, the product is whatever THAT group is sold as.
         *
         * Frequently NULL on this path, and legitimately so. An operator types a
         * group here rather than picking a product, and may open an account
         * directly into a group the catalogue does not sell — a bespoke
         * arrangement, an internal test account, a group added on the server this
         * morning. NULL records that honestly instead of guessing.
         */
        productId: await this.productForGroup(created.group),
        environment: input.environment,
        currency: created.currency,
        leverage: created.leverage,
        // Zero, not the MT5 balance: a new account has none, and writing
        // anything else here would be inventing a number MT5 did not give us.
        balance: '0',
        status: 'active',
      })
      .returning();

    this.audit.record(actor.id, 'trading.account_create', 'trading_account', row.id, {
      login: String(created.login),
      group: created.group,
      environment: input.environment,
      leverage: created.leverage,
      clientId: client.id,
      /*
       * Logged because the catalogue is editable and this row is not re-derived.
       * "Opened as Standard" is the fact somebody reconstructing a commission
       * dispute needs, and after a group is re-pointed the audit entry is the
       * only place outside this row that still says so.
       */
      productId: row.productId,
    });

    this.logger.log(
      `Opened MT5 account ${created.login} (${created.group}) for client ${client.id}`,
    );

    /*
     * THE PASSWORDS GO TO THE CLIENT AND NOWHERE ELSE.
     *
     * An earlier version returned them here so the console could display them.
     * That is wrong however carefully the dialog is built: the account's owner
     * is the only person who should ever hold its trading password, and the
     * response to this call is read by a member of STAFF. It would also sit in
     * their browser's memory, in any error reporting the console loads, and in
     * whatever they pasted it into to pass it on.
     *
     * Awaited rather than fired and forgotten — this mail is the only copy that
     * will ever exist. `send()` still swallows SMTP failure and logs it, so a
     * blip does not roll back a real MT5 account; the log names the login, and
     * an operator resets the password deliberately.
     */
    await this.email.sendTradingAccountOpenedEmail(
      client.email,
      client.firstName,
      String(created.login),
      input.environment,
      created.currency,
      created.leverage,
      created.masterPassword,
      created.investorPassword,
    );

    const response = {
      id: row.id,
      login: String(created.login),
      group: created.group,
      currency: created.currency,
      leverage: created.leverage,
      environment: input.environment,
      /*
       * Reported so the console can tell the operator where the credentials
       * went — "sent to ada@example.com" is actionable, and silence after a
       * successful create reads as though something was forgotten.
       */
      credentialsSentTo: client.email,
    };

    /*
     * RBAC-03. `credentialsSentTo` IS the client's email address, so an operator
     * whose role hides `client.email` was handed it simply by opening an account
     * for that client — on a route declaring no response schema, which is why
     * the census could not see it either.
     *
     * Masked rather than dropped for everyone: "sent to ada@example.com" is
     * genuinely actionable, and silence after a successful create reads as
     * though something was forgotten. A reader who may see the address still
     * gets it; one who may not gets the field absent and `maskedFields` saying
     * so — the same contract every other screen makes.
     *
     * `createOwnAccount` and `resetOwnAccountPassword` return the same field and
     * are deliberately NOT masked: they are a CLIENT reading their own address
     * in the portal, where an administrator's field mask has no standing.
     */
    return {
      ...response,
      maskedFields: maskedFieldsFor('tradingAccountCreated', actor.fieldMask),
    };
  }

  /**
   * A CLIENT opening their own account.
   *
   * ## Not `createAccount` with a different caller
   *
   * That one takes a group and an admin, and checks `trading.create`. This one
   * has no actor with permissions, cannot be handed a group — see
   * `SelfServiceGroups` — and answers to a different rule about who may open
   * what. Sharing an entry point would mean one method whose every line asks
   * "is this an operator or a client", which is how the group check eventually
   * gets skipped for one of them.
   *
   * ## KYC gates LIVE and not demo
   *
   * A live account holds real money and is a regulated relationship, so it
   * needs a verified client. A demo account holds practice money and is how
   * somebody decides whether to bother verifying at all — gating it would put
   * the paperwork before the reason to do it.
   */
  async createOwnAccount(input: {
    userId: string;
    environment: 'live' | 'demo';
    group: string;
    /** Validated against the offered ladder by the caller. */
    leverage?: number;
    /** A label for the account. Defaults to the client's own name. */
    name?: string;
    /** DEMO only — refused on a live account rather than ignored. */
    startingBalance?: string;
  }) {
    this.assertBridge();

    const [client] = await this.db
      .select({
        id: users.id,
        email: users.email,
        firstName: users.firstName,
        lastName: users.lastName,
        country: users.country,
        phone: users.phone,
      })
      .from(users)
      .where(eq(users.id, input.userId))
      .limit(1);

    if (!client) throw new NotFoundError('Client not found.');

    /*
     * A CAP on how many a client may open, set by the operator.
     *
     * Every account is a real row on the broker's server that somebody has to
     * administer, and this endpoint is reachable by anyone with a session — a
     * script could otherwise open thousands. Counted per environment so a
     * client experimenting with demos cannot lock themselves out of a live one.
     *
     * ZERO is a real setting and reads differently: nothing about the client's
     * own account count explains it, so the message says the door is shut
     * rather than that they have too many.
     */
    const terms = await this.terms();
    const cap = input.environment === 'live' ? terms.maxLiveAccounts : terms.maxDemoAccounts;

    const existing = await this.db
      .select({ id: tradingAccounts.id })
      .from(tradingAccounts)
      .where(
        and(
          eq(tradingAccounts.userId, client.id),
          eq(tradingAccounts.environment, input.environment),
        ),
      );

    if (cap === 0) {
      throw new ValidationError(
        `New ${input.environment} accounts are not being opened online at the moment. ` +
          'Please contact support.',
      );
    }

    if (existing.length >= cap) {
      throw new ValidationError(
        `You already have ${existing.length} ${input.environment} ` +
          `account${existing.length === 1 ? '' : 's'}, which is the maximum. ` +
          'Contact support if you need another.',
      );
    }

    /*
     * REFUSED rather than ignored on a live account.
     *
     * Silently dropping a number somebody typed into a funding box is the worst
     * available behaviour: they believe the account is funded, and find out it
     * is not by trying to trade. The portal does not show the field for live,
     * so reaching this means a hand-made request — which deserves an answer
     * rather than a shrug.
     */
    if (input.startingBalance && input.environment !== 'demo') {
      throw new ValidationError(
        'A live account cannot be opened with a starting balance. Fund it from your wallet ' +
          'once it is open.',
      );
    }

    /*
     * The name is this client's alone to reuse, and they may not.
     *
     * LAST of the refusals and FIRST of the writes — deliberately on this side
     * of the bridge call. MT5 has no rollback and neither does anything below
     * it: an account created there and then refused here would be a live
     * trading account the client cannot see, cannot name and did not know was
     * opened.
     *
     * Only when the client actually chose one. An unnamed account stores NULL
     * (see the insert below), and NULL is not a name that can collide — a
     * client may open any number of accounts without naming them.
     */
    const chosenName = input.name?.trim() || null;
    if (chosenName) await this.assertNameFree(client.id, chosenName);

    const created = await this.bridge.createAccount({
      group: input.group,
      // The client's own name when they did not choose one — that is what MT5
      // expects in this field and what makes a row in the manager terminal
      // identifiable.
      name: chosenName || `${client.firstName} ${client.lastName}`.trim(),
      email: client.email,
      country: client.country ?? undefined,
      phone: client.phone ?? undefined,
      leverage: input.leverage,
      externalId: client.id,
    });

    /*
     * Funded AFTER creation, because MT5 has no "open with a balance" — an
     * account is created empty and credited by a dealer operation, which is the
     * same call the back office uses.
     *
     * Failure here does NOT fail the request. The account exists on the broker's
     * server and rolling it back is not possible; reporting an error would leave
     * the client believing they have nothing when they have an unfunded account.
     * It is logged and the real balance is read back below, so what the portal
     * shows is what MT5 holds rather than what we hoped it would.
     */
    let funded = false;
    if (input.startingBalance && input.environment === 'demo') {
      const capped = capDemoFunding(input.startingBalance, terms.maxDemoDeposit);
      try {
        await this.bridge.balance({
          login: String(created.login),
          amount: capped,
          type: 'balance',
          comment: 'Demo starting balance',
          // The MT5 login is unique and this credit happens exactly once per
          // account, so it is a stable key for the one operation it names.
          idempotencyKey: `demo-funding-${created.login}`,
        });
        funded = true;
      } catch (error) {
        this.logger.error(
          `Opened demo account ${created.login} but could not fund it with ${capped}: ` +
            `${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }

    // Read back rather than assumed: if funding failed, the row must say 0.
    const snapshot = funded
      ? await this.bridge.getAccount(String(created.login)).catch(() => null)
      : null;

    const [row] = await this.db
      .insert(tradingAccounts)
      .values({
        userId: client.id,
        login: String(created.login),
        // Stored so the PORTAL can label this account without asking the
        // bridge. The same string went to MT5 above as the holder name; NULL
        // when the client chose nothing, so the portal falls back to the login
        // rather than showing a name nobody picked.
        name: chosenName,
        /*
         * THE GROUP — see the note on the admin path above, which this omitted
         * for the same reason and with the same consequence.
         *
         * It matters more here: this path exists because the client chose a
         * PRODUCT and a currency, and the group is the only record of which
         * product that was. Dropping it threw away the one fact the form was
         * collecting, so an account opened as "Standard" was indistinguishable
         * afterwards from one opened as anything else.
         */
        mt5Group: created.group,
        /*
         * THE PRODUCT the client actually chose (0080).
         *
         * This is the path the column exists for. The open-account form asks for
         * a currency and a PRODUCT, `SelfServiceGroups` turns that choice into a
         * group, and until now the group was the only surviving record of it —
         * so the choice was readable only for as long as the catalogue kept
         * pointing that group at the same product. Here it becomes a fact about
         * the account instead of a fact about the catalogue.
         *
         * Resolved from `created.group` rather than carried down from the form,
         * so both open paths record the product the same way: from the group the
         * account is actually in. Nothing is offered to a client that is not in
         * the catalogue, so this is NULL here only if the group was detached
         * between the picker rendering and the account opening.
         */
        productId: await this.productForGroup(created.group),
        environment: input.environment,
        currency: created.currency,
        leverage: created.leverage,
        balance: snapshot?.balance ?? '0',
        status: 'active',
      })
      .returning();

    this.logger.log(
      `Client ${client.id} opened their own MT5 account ${created.login} (${created.group})`,
    );

    // To the client's registered address, not into this response — see the note
    // on the admin path above. It applies here for an additional reason: the
    // browser making this call is not necessarily the client's own.
    await this.email.sendTradingAccountOpenedEmail(
      client.email,
      client.firstName,
      String(created.login),
      input.environment,
      created.currency,
      created.leverage,
      created.masterPassword,
      created.investorPassword,
      input.name?.trim() || undefined,
      // What MT5 holds, not what was asked for: if funding failed this is '0'
      // and the mail correctly omits the line rather than promising money that
      // is not there.
      snapshot?.balance ?? '0',
    );

    /*
     * Both sides of the event, from the one place that knows it happened.
     *
     * The CLIENT's bell matters here because the credentials went to their
     * mailbox and nothing on screen said so: this call returns
     * `credentialsSentTo` and the portal renders it once, so a client who
     * navigated away — or whose mail is slow — had no in-app record that the
     * account exists. No password or login secret travels in `params`; the
     * login number is public-facing (it is on every statement) and the
     * credentials remain email-only, which is the whole point of the note above.
     *
     * The ADMIN kind is `opened`, not `requested`, because that is what
     * occurred. This path is self-service and completes immediately — there is
     * no approval queue and nobody has to act — so naming it "requested" would
     * put a work item in an operator's bell that they cannot action and cannot
     * clear. It is informational: dealing desks want to know when live accounts
     * appear on their groups.
     *
     * `trading.view` holds it, matching the screen it links to, and the fan-out
     * IS scope-filtered on the subject (unlike registration): by the time a
     * client opens an account they have been through intake, so a territoried
     * admin who cannot see the client should not be told about their account.
     *
     * Post-write and never-throws, and `void` rather than awaited: the account
     * is already open at MT5 and the row already committed, so no failure here
     * may propagate into a response that would suggest otherwise.
     */
    void this.notifications.notify({
      recipient: { kind: 'client', id: client.id },
      kind: 'trading_account.opened',
      params: {
        login: String(created.login),
        environment: input.environment,
        currency: created.currency,
        leverage: created.leverage,
      },
      dedupeKey: `trading_account.opened:${row.id}`,
    });

    void this.notifications.notifyAdminsWithPermission(
      'trading.view',
      {
        kind: 'admin.trading_account.opened',
        params: {
          userId: client.id,
          login: String(created.login),
          environment: input.environment,
          currency: created.currency,
        },
        dedupeKey: `admin.trading_account.opened:${row.id}`,
      },
      { subjectClientId: client.id },
    );

    return {
      id: row.id,
      login: String(created.login),
      environment: input.environment,
      currency: created.currency,
      leverage: created.leverage,
      balance: snapshot?.balance ?? '0',
      credentialsSentTo: client.email,
    };
  }

  /**
   * The client's OWN account, or nothing.
   *
   * One lookup shared by the two self-service methods below, and the single
   * place ownership is decided for them. Both take an account id straight from a
   * browser, so the `userId` predicate is the whole control: without it a client
   * could rename — or reset the credentials of — any account whose id they could
   * name.
   *
   * A row belonging to somebody else answers NOT FOUND rather than forbidden.
   * "You may not touch this account" confirms the account exists and is
   * somebody's, which is a membership oracle for anyone enumerating ids, and the
   * client has neither a way nor a reason to tell the two apart.
   */
  private async ownAccount(userId: string, accountId: string) {
    const [row] = await this.db
      .select({
        id: tradingAccounts.id,
        login: tradingAccounts.login,
        environment: tradingAccounts.environment,
        email: users.email,
        firstName: users.firstName,
      })
      .from(tradingAccounts)
      .innerJoin(users, eq(users.id, tradingAccounts.userId))
      .where(and(eq(tradingAccounts.id, accountId), eq(tradingAccounts.userId, userId)))
      .limit(1);

    if (!row) throw new NotFoundError('Trading account not found.');

    /*
     * A row with no login exists in the CRM and nowhere on MT5 — an account
     * whose provisioning failed part-way. Neither operation below can mean
     * anything for it, and the bridge would otherwise be asked for
     * `/accounts/null`.
     */
    if (!row.login) {
      throw new ValidationError('This account is not fully set up yet. Please contact support.');
    }

    return { ...row, login: row.login };
  }

  /**
   * Reset BOTH passwords on the client's own trading account.
   *
   * ## The new passwords do NOT come back in the response
   *
   * They go to the client's registered address and nowhere else — the same rule
   * the opening mail follows, plus one reason specific to a RESET: the person
   * asking is by definition someone who has lost control of a credential.
   * Returning the replacement to the browser that asked hands it to whoever is
   * sitting at that browser, which is sometimes the party the reset exists to
   * shut out. The registered mailbox is the one channel already proven to belong
   * to the account holder.
   *
   * The caller therefore learns only WHERE it went, which is also what lets the
   * portal say something more useful than "done".
   *
   * ## Not idempotent, and the failure is asymmetric
   *
   * MT5 rotates first, the mail goes second. If the send fails, the client is
   * locked out of an account that worked a moment ago — a password change has no
   * rollback, so this must not pretend otherwise.
   * `sendTradingAccountPasswordResetEmail` is awaited and swallows its own
   * failure into a log line naming the login, which is what an operator needs to
   * put it right. Raising an error to the client instead would claim a rollback
   * that did not happen.
   */
  async resetOwnAccountPassword(input: { userId: string; accountId: string }) {
    this.assertBridge();

    const account = await this.ownAccount(input.userId, input.accountId);

    const reset = await this.bridge.resetPasswords(account.login);
    if (!reset) {
      /*
       * The CRM holds a login MT5 does not. Nothing the client can do fixes it,
       * so it reads as an account needing support rather than as their mistake.
       */
      this.logger.error(
        `Trading account ${account.id} has login ${account.login}, which MT5 does not know.`,
      );
      throw new ValidationError(
        'This account could not be found on the trading server. Please contact support.',
      );
    }

    this.logger.log(
      `Client ${input.userId} reset the passwords on their MT5 account ${account.login}`,
    );

    await this.email.sendTradingAccountPasswordResetEmail(
      account.email,
      account.firstName,
      account.login,
      account.environment,
      reset.masterPassword,
      reset.investorPassword,
    );

    return { login: account.login, credentialsSentTo: account.email };
  }

  /**
   * Rename the client's own trading account.
   *
   * ## Two writes, and the order is the point
   *
   * `trading_accounts.name` is what the PORTAL reads — a label must not depend
   * on the trading server being reachable — and MT5 holds the same string as
   * the account holder's name, so the terminal and the portal agree.
   *
   * MT5 goes FIRST and the database second. MT5 is the write that can fail for
   * reasons of its own (unreachable, unknown login, a name it refuses), and a
   * failure there must leave nothing changed. The reverse order would show the
   * client a renamed account in the portal while their terminal still said
   * something else, with no error to explain the difference.
   *
   * If the local write failed after MT5 succeeded the two would disagree the
   * other way — which is why the database update is the last statement and its
   * failure propagates: a 500 the client can retry is better than a silent
   * divergence, and retrying is safe because both writes are idempotent for the
   * same name.
   */
  /**
   * Refuse a name this client has already used.
   *
   * ## Before MT5, always
   *
   * Both callers run this ahead of the bridge call. Ordering is the whole point:
   * creating the account on the trading server and THEN discovering the name is
   * taken leaves a real MT5 account behind that the client never got told about
   * and cannot see — the broker's server has no rollback, and our transaction
   * does not reach it.
   *
   * ## Case-insensitive
   *
   * "Swing trading" and "swing trading" are the same name to the person reading
   * a list of them, and the unique index on the table uses `lower(name)` for the
   * same reason. The two must agree, or this reports a name as free that the
   * insert then rejects with a database error.
   *
   * ## Why this exists when the index does
   *
   * The index is what makes the rule TRUE — a check-then-insert races itself on
   * a double submit. This is what makes it USABLE: a 409 carrying
   * `ACCOUNT_NAME_TAKEN` lets the portal put the message on the name field,
   * where the one thing the client can change is. A unique-violation escaping to
   * the exception filter would be a 500 saying nothing.
   *
   * `exceptAccountId` is for the rename path: an account keeps its own name, so
   * renaming "Swing trading" to "Swing trading" must not be a conflict with
   * itself. Trimming a name, or changing its capitalisation, is a real edit and
   * still reaches MT5.
   */
  private async assertNameFree(userId: string, name: string, exceptAccountId?: string) {
    const [clash] = await this.db
      .select({ id: tradingAccounts.id })
      .from(tradingAccounts)
      .where(
        and(
          eq(tradingAccounts.userId, userId),
          sql`lower(${tradingAccounts.name}) = lower(${name})`,
          ...(exceptAccountId ? [ne(tradingAccounts.id, exceptAccountId)] : []),
        ),
      )
      .limit(1);

    if (clash) {
      throw new AccountNameTakenError(
        `You already have an account named "${name}". Choose a different name.`,
      );
    }
  }

  async renameOwnAccount(input: { userId: string; accountId: string; name: string }) {
    this.assertBridge();

    /*
     * Trimmed and length-checked HERE, not only at the DTO: MT5 accepts a name
     * of nothing but spaces and the terminal then shows an account belonging to
     * nobody. The ceiling matches what MT5 stores — a longer name is truncated
     * server-side, which would silently disagree with what the client typed.
     */
    const name = input.name.trim();
    if (name.length === 0) {
      throw new ValidationError('Enter a name for this account.');
    }
    if (name.length > 128) {
      throw new ValidationError('That name is too long — use 128 characters or fewer.');
    }

    const account = await this.ownAccount(input.userId, input.accountId);

    // Itself excluded — see `assertNameFree`. Before the bridge call, so a
    // refusal cannot leave MT5 holding a name this database does not.
    await this.assertNameFree(input.userId, name, account.id);

    const renamed = await this.bridge.updateName(account.login, name);
    if (!renamed) {
      this.logger.error(
        `Trading account ${account.id} has login ${account.login}, which MT5 does not know.`,
      );
      throw new ValidationError(
        'This account could not be found on the trading server. Please contact support.',
      );
    }

    // Second, and only once MT5 has accepted it — see the note above.
    await this.db
      .update(tradingAccounts)
      .set({ name, updatedAt: new Date() })
      .where(eq(tradingAccounts.id, account.id));

    this.logger.log(`Client ${input.userId} renamed their MT5 account ${account.login}`);

    return { id: account.id, login: account.login, name };
  }

  /**
   * Top a DEMO account up with more practice money, on the client's own ask.
   *
   * ## Why this exists as its own path
   *
   * A demo balance is consumed by practising, which is the entire point of it.
   * Until now the only funding a demo account ever received was
   * `startingBalance` at CREATION, so a client who traded theirs down had one
   * remedy: open another account. That is a worse outcome for everybody — it
   * clutters their list, it costs an MT5 login per mistake, and it loses the
   * history they were practising against.
   *
   * ## It is NOT the admin balance operation
   *
   * `adjustBalance` is a DEALER correction: any direction, any amount, any
   * account, gated on `trading.deposit` / `trading.withdraw` and audited as a
   * back-office act. This is a client funding their own practice account, so it
   * is deliberately much narrower — credit only, demo only, their own account
   * only, capped by the same operator ceiling that bounds the starting balance.
   *
   * Sharing one method would have meant one set of guards trying to be both, and
   * the failure mode of getting that wrong is a client debiting a live account.
   *
   * ## ⚠️ DEMO ONLY, checked here and not merely in the UI
   *
   * A live balance is real money that arrives through a deposit or a transfer,
   * both of which post a wallet leg and a ledger entry. Crediting one here would
   * mint money on the trading server with no counterpart anywhere in the CRM —
   * so the refusal is on the environment, in the service, where no caller can
   * route around it.
   *
   * ## The cap is applied, not enforced by refusal
   *
   * `capDemoFunding` clamps rather than throws, which is the rule the opening
   * path already follows: a fat-fingered extra zero should still leave a working
   * account rather than an error message. The portal is told the ceiling by
   * `self-service` so it can say so before the client types.
   */
  async fundOwnDemoAccount(input: { userId: string; accountId: string; amount: string }) {
    this.assertBridge();

    const account = await this.ownAccount(input.userId, input.accountId);

    if (account.environment !== 'demo') {
      throw new ValidationError(
        'Only demo accounts can be topped up this way. To add money to a live account, ' +
          'transfer it from your wallet.',
      );
    }

    /*
     * Positive and finite, checked as a DECIMAL rather than a number (§6.1).
     * The DTO bounds it too; this is the guard that holds if anything else ever
     * calls the method.
     */
    let requested: Decimal;
    try {
      requested = new Decimal(input.amount);
    } catch {
      throw new ValidationError('Enter a valid amount.');
    }
    if (!requested.isFinite() || requested.lessThanOrEqualTo(0)) {
      throw new ValidationError('Enter an amount greater than zero.');
    }

    const terms = await this.terms();
    const capped = capDemoFunding(requested.toString(), terms.maxDemoDeposit);

    /*
     * NOT idempotent, and deliberately so.
     *
     * Every other balance call here carries a key naming an operation that
     * happens once — `demo-funding-<login>` is the account's one starting
     * balance. A top-up is a thing a client may legitimately do again ten
     * minutes later for the same amount, and a stable key would silently drop
     * the second one as a replay.
     *
     * A unique key per call is therefore the honest shape. The protection
     * against a double-click is the throttle on the route plus the portal
     * disabling its button while the request is in flight — the same protection
     * the password reset relies on, and for the same reason.
     */
    const result = await this.bridge.balance({
      login: account.login,
      amount: capped,
      type: 'balance',
      comment: 'Demo top-up',
      idempotencyKey: `demo-topup-${account.login}-${randomUUID()}`,
    });

    /*
     * Read back from MT5 rather than computed, and written through
     * `Mt5AccountSyncService` so `balance_synced_at` is stamped with it — see
     * `adjustBalance`, which records at length why setting `balance` alone
     * leaves the freshest figure in the system looking unconfirmed to the
     * sweep's staleness guard.
     *
     * `readAt` AFTER the call, for the reason given there: stamped before, it
     * understates the read by the whole round trip, and understating is the
     * direction that lets an older sweep read overwrite this one.
     *
     * A failed read is not a failed top-up. The money is on the trading server
     * either way, and the sweep corrects the column shortly.
     */
    const snapshot = await this.bridge.getAccount(account.login).catch(() => null);
    const readAt = new Date();
    if (snapshot) {
      await this.accountSync.recordFromOperation(account.login, snapshot.balance, readAt);
    }

    this.logger.log(`Client ${input.userId} topped up demo account ${account.login} by ${capped}`);

    return {
      id: account.id,
      login: account.login,
      amount: capped,
      dealId: String(result.dealId),
      balance: snapshot?.balance ?? null,
    };
  }

  /*
   * `adjustBalance` USED TO BE HERE — the DEALER credit/debit, removed with its
   * route (see `mt5-accounts.controller.ts` for the full reasoning).
   *
   * It moved the MT5 balance with no wallet leg and no ledger entry. That is a
   * coherent operation in accounting terms and it is still the only honest way
   * to describe money the broker gives or takes outside a client deposit — but
   * it gave the console a second money control that recorded nothing, and an
   * operator picking it by mistake moved money that no statement, ledger or
   * report could afterwards explain.
   *
   * Every console money movement is recorded now.
   * `AdminMoneyService.fundTradingAccount` carries both directions as a wallet
   * credit plus a transfer, or a transfer plus a wallet credit.
   *
   * ## What this deliberately does NOT restore
   *
   * If a genuine unrecorded dealer operation is ever needed again — a swap
   * correction MT5 itself booked, say — it must not come back as a console
   * button beside the funding control. That adjacency is what broke: two
   * controls, same visible effect, one silent. It would need to be its own
   * surface, its own permission, and a name that could not be mistaken for
   * funding.
   *
   * `fundOwnDemoAccount` above is the CLIENT's own demo top-up and is untouched.
   * It is also why no operator control is needed for demo balances: practice
   * money has no wallet and no ledger to record a movement against, so the
   * funding path refuses demo accounts in both directions.
   */

  /**
   * What MT5 says about this account RIGHT NOW.
   *
   * Distinct from the row in `trading_accounts`, which is a cache that goes
   * stale the moment the client opens a position. A screen showing money should
   * say which of the two it is looking at.
   */
  async liveSnapshot(accountId: string, actor: AuthenticatedAdmin) {
    assertActorCan(actor, 'trading.view', 'read a live MT5 balance');

    // Scope before the bridge: out-of-scope is a 404 whether or not MT5 answers.
    const [account] = await this.db
      .select()
      .from(tradingAccounts)
      .where(
        and(
          eq(tradingAccounts.id, accountId),
          clientScopePredicate(actor.clientScope, tradingAccounts.userId),
        ),
      )
      .limit(1);

    if (!account) throw new NotFoundError('Trading account not found.');
    this.assertBridge();
    if (!account.login) return null;

    return await this.bridge.getAccount(account.login);
  }

  /**
   * Refuse early when the bridge is not configured.
   *
   * Without this the failure is a connection error from inside the HTTP client,
   * which reads as "MT5 is down" — a different problem with a different owner.
   * An unconfigured bridge is a deployment that was never finished.
   */
  private assertBridge(): void {
    if (!this.bridge.isConfigured) {
      throw new ValidationError(
        'The MT5 bridge is not configured on this deployment, so trading accounts cannot be ' +
          'opened or funded. Set MT5_BRIDGE_URL and MT5_BRIDGE_API_KEY.',
      );
    }
  }
}
