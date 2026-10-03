import { Inject, Injectable, Logger } from '@nestjs/common';
import { and, eq, isNotNull, isNull, sql } from 'drizzle-orm';
import { DRIZZLE_DB } from '../../../database/database.module';
import type { Db } from '../../../database/db';
import { currencies, mt5Deals, tradingAccounts, users } from '../../../database/schema';
import { Mt5BridgeClient, assertBridgeConfigured } from './mt5-bridge.client';
import { AdminAuditService } from '../../admin/admin-audit.service';
import { EmailService } from '../../email/email.service';
import { parseLocale } from '../../../common/i18n/locale';
import { assertActorCan } from '../../../common/security/actor';
import { maskedFieldsFor } from '../../../common/security/field-mask';
import { clientScopePredicate } from '../../../common/security/client-scope';
import type { AuthenticatedAdmin } from '../../admin/guards/admin.guard';
import {
  ConflictError,
  NotFoundError,
  ValidationError,
} from '../../../common/errors/domain-errors';
import { AppSettingsStore } from '../../../store/app-settings.store';
import { ProductsStore } from '../../../store/products.store';
import { tradingTermsFrom } from '../../../common/trading-terms';
import { isUniqueViolation, violatesConstraint } from '../../../common/errors/pg-violation';

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
  /**
   * The environment of the group MT5 ACTUALLY opened the account in.
   *
   * ## ⚠️ This exists because commission was paid on demo trades
   *
   * `environment` used to be written straight from the request, while
   * `mt5Group` and `productId` beside it were read back from the broker's own
   * response. The one column with money hanging off it — it is what the IB
   * engine checks before accruing — was the one field nobody verified.
   *
   * A deployment whose catalogue holds a single LIVE group answers every open
   * with that group, demo requests included. The account then sits in a live
   * group while the CRM files it however the caller asked, and every trade on
   * it pays a partner real commission and the client a real rebate.
   *
   * Falls back to the REQUESTED value when the catalogue does not sell the
   * group, which is legitimate on the admin path: an operator can open an
   * account directly into a bespoke or internal group the catalogue has never
   * heard of. There is nothing to verify against there, so the caller's word is
   * all there is — and the log line says so rather than leaving it silent.
   */
  async environmentForGroup(
    group: string,
    requested: 'live' | 'demo',
    login: string | number,
  ): Promise<'live' | 'demo'> {
    let actual: 'live' | 'demo' | null = null;
    try {
      actual = await this.products.environmentForGroup(group);
    } catch (error) {
      this.logger.error(
        `Could not resolve the environment for group ${group}; account ${login} is being ` +
          `recorded as ${requested} on the caller's word. ` +
          `${error instanceof Error ? error.message : String(error)}`,
      );
      return requested;
    }

    if (actual === null) {
      this.logger.warn(
        `Group ${group} is not in the catalogue, so account ${login} is recorded as ` +
          `${requested} unverified. If this is a live group, every trade on it will accrue ` +
          `partner commission.`,
      );
      return requested;
    }

    if (actual !== requested) {
      /*
       * LOUD. The broker and the request disagree about whether this account
       * trades real money, and the broker is the one that decides. Recording
       * the request instead is how a demo account ends up paying commission —
       * or how a live one silently stops.
       */
      this.logger.error(
        `Account ${login} was requested as ${requested} but MT5 opened it in ${group}, which ` +
          `the catalogue sells as ${actual}. Recording ${actual} — the broker decides what an ` +
          `account is, and this column gates whether its trades pay commission.`,
      );
    }

    return actual;
  }

  /**
   * The product an account opened in `group` is recorded under — 0142.
   *
   * A group may back several products, and the product decides the account's
   * commission type, so it must be the one somebody CHOSE:
   *
   *  - `chosen` given → it must actually sell the group, or the request is
   *    refused (a product that does not sell the group would record terms the
   *    account was never opened on).
   *  - not given, one product sells the group → that one.
   *  - not given, several do → REFUSED, naming them. Guessing would record a
   *    commission type nobody picked, and it decides what every trade pays.
   *  - none does → NULL. An account may be opened into a group no product
   *    carries; that is recorded honestly rather than refused.
   */
  /**
   * The product to RECORD once MT5 has opened the account.
   *
   * Normally the one resolved before the bridge call. MT5 reports back the group
   * it actually used, and if that is not the one requested (beyond casing), the
   * pre-resolved product may not sell it — so the product is looked up again
   * for the real group, and recorded only when exactly one product sells it.
   * Never a refusal here: the account already exists on MT5.
   */
  async recordedProduct(
    createdGroup: string,
    requestedGroup: string,
    resolved: string | null,
  ): Promise<string | null> {
    if (createdGroup.toLowerCase() === requestedGroup.toLowerCase()) return resolved;

    try {
      const candidates = await this.products.productIdsForGroup(createdGroup);
      if (candidates.length === 1) return candidates[0];
      this.logger.error(
        `MT5 opened the account in ${createdGroup}, not the requested ${requestedGroup}, and ` +
          `${candidates.length === 0 ? 'no product' : 'more than one product'} sells that group. ` +
          'It is recorded with no product; set one on the account.',
      );
      return null;
    } catch (error) {
      this.logger.error(
        `Could not resolve the product for group ${createdGroup}; the account is being recorded ` +
          `with no product. ${error instanceof Error ? error.message : String(error)}`,
      );
      return null;
    }
  }

  async productForGroup(group: string, chosen?: string): Promise<string | null> {
    if (chosen) {
      if (!(await this.products.productSellsGroup(chosen, group))) {
        throw new ValidationError(
          `The chosen product does not sell the MT5 group "${group}". Choose a product that ` +
            'carries this group, or attach the group to it first.',
        );
      }
      return chosen;
    }

    const candidates = await this.products.productIdsForGroup(group);
    if (candidates.length <= 1) return candidates[0] ?? null;

    const names = (await this.products.listProducts())
      .filter((product) => candidates.includes(product.id))
      .map((product) => product.name);
    throw new ValidationError(
      `The MT5 group "${group}" is sold by more than one product (${names.join(', ')}). ` +
        'Choose which product this account is opened under.',
    );
  }

  /**
   * The operator's trading terms, read fresh on each create.
   *
   * Not cached. A create is already several network round trips to the broker,
   * so one indexed read of a single-row table costs nothing measurable — and an
   * operator who lowers a cap because of an abuse incident should not have to
   * wait out a TTL or restart the process for it to take effect.
   */
  async terms() {
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
      userId: number;
      group: string;
      /** Required only when the group is sold by more than one product (0142). */
      productId?: string;
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
        locale: users.locale,
      })
      .from(users)
      .where(and(eq(users.id, input.userId), clientScopePredicate(actor.clientScope, users.id)))
      .limit(1);

    if (!client) throw new NotFoundError('Client not found.');
    this.assertBridge();

    /*
     * The product BEFORE the bridge: an ambiguous group is refused here, while
     * nothing exists on MT5 yet, rather than after an account was opened that
     * the CRM then cannot record.
     */
    const productId = await this.productForGroup(input.group, input.productId);
    // Named by the rule every opened account follows — see `autoAccountName`.
    const accountName = await this.autoAccountName(client);

    const created = await this.bridge.createAccount({
      group: input.group,
      name: accountName,
      email: client.email,
      country: client.country ?? undefined,
      phone: client.phone ?? undefined,
      leverage: input.leverage,
      // Our id in MT5's comment field, so a row on either side resolves to the
      // other. MT5 has no foreign keys and no custom columns.
      externalId: String(client.id),
    });

    const recordedProductId = await this.recordedProduct(created.group, input.group, productId);
    const recordedEnvironment = await this.environmentForGroup(
      created.group,
      input.environment,
      created.login,
    );
    const { result: row } = await this.insertNamed(
      client,
      accountName,
      String(created.login),
      (name) =>
        this.db
          .insert(tradingAccounts)
          .values({
            userId: client.id,
            login: String(created.login),
            name,
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
            productId: recordedProductId,
            /* From the group MT5 confirmed, not from the request — see the helper. */
            environment: recordedEnvironment,
            currency: created.currency,
            leverage: created.leverage,
            // Zero, not the MT5 balance: a new account has none, and writing
            // anything else here would be inventing a number MT5 did not give us.
            balance: '0',
            status: 'active',
          })
          .returning()
          .then((rows) => rows[0]),
    );

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
      undefined,
      undefined,
      // Opened by STAFF: the client's stored language, not the console's.
      parseLocale(client.locale),
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
   * An opened account's name (owner, 29 Sep 2026): the client's "First Last" for
   * their FIRST account, then "First Last-2", "First Last-3"… — the number is the
   * account's place among theirs. The client never types it.
   *
   * Counted over every account the client holds (named or not), then moved on
   * past any name already taken, so it is unique per client as
   * `trading_accounts_user_name_uq` requires.
   */
  async autoAccountName(client: {
    id: number;
    firstName: string | null;
    lastName: string | null;
    email: string;
  }): Promise<string> {
    const base = (
      `${client.firstName ?? ''} ${client.lastName ?? ''}`.trim() || client.email.split('@')[0]
    ).slice(0, 120);
    const rows = await this.db
      .select({ name: tradingAccounts.name })
      .from(tradingAccounts)
      .where(eq(tradingAccounts.userId, client.id));
    const taken = new Set(
      rows.map((row) => row.name?.toLowerCase()).filter((name): name is string => Boolean(name)),
    );
    const nameFor = (place: number) => (place === 1 ? base : `${base}-${place}`);
    let place = rows.length + 1;
    while (taken.has(nameFor(place).toLowerCase())) place += 1;
    return nameFor(place);
  }

  /**
   * Insert the account's row under its derived name — and if a concurrent open
   * took that name first (the unique index refuses it), take the next one and
   * rename the account on MT5 to match. The account already EXISTS on MT5 by
   * now, so refusing here would leave a trading account the client cannot see.
   */
  async insertNamed<T>(
    client: { id: number; firstName: string | null; lastName: string | null; email: string },
    first: string,
    login: string,
    insert: (name: string) => Promise<T>,
  ): Promise<{ result: T; name: string }> {
    let name = first;
    for (let attempt = 0; ; attempt++) {
      try {
        return { result: await insert(name), name };
      } catch (error) {
        if (attempt >= 4 || !violatesConstraint(error, 'trading_accounts_user_name_uq'))
          throw error;
        name = await this.autoAccountName(client);
        await this.bridge.updateName(login, name).catch(() => false);
      }
    }
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
  /* ── Linking an EXISTING MT5 account (owner, 29 Sep 2026) ─────────────────
   *
   * The broker's server holds accounts the CRM never recorded — opened in the
   * manager terminal, or on the platform this one replaced. Their snapshots are
   * dropped (`ingestSnapshot` matches by login only) and their deals wait in
   * `mt5_deals` as orphans. Linking records the login under a client with the
   * product whose terms its trades pay: from the next commission run the
   * waiting deals accrue like any other client's — the batch LEFT JOINs
   * `trading_accounts` on login, so no backfill is needed. Deals already
   * decided (marked processed) are not revisited, and deals older than
   * `IB_ACCRUAL_START` stay unpaid by that rule, exactly as for anyone else.
   */

  /**
   * One MT5 login, for the link screen: MT5's snapshot and holder, whether the
   * CRM already owns it (the owner named only inside the reader's territory),
   * the products that sell its group, and how many of its deals are waiting.
   */
  async lookupMt5Account(login: string, actor: AuthenticatedAdmin) {
    assertActorCan(actor, 'trading.create', 'look up an MT5 account to link');
    this.assertBridge();
    const normalised = normaliseLogin(login);

    const [owned] = await this.db
      .select({ userId: tradingAccounts.userId })
      .from(tradingAccounts)
      .where(eq(tradingAccounts.login, normalised))
      .limit(1);

    const snapshot = await this.bridge.getAccount(normalised);
    if (!snapshot) throw new NotFoundError(`MT5 has no account with login ${normalised}.`);
    const holder = await this.bridge.getAccountHolder(normalised).catch((error: unknown) => {
      // The holder is a courtesy for the operator's check, never a reason to fail.
      this.logger.warn(
        `Could not read the MT5 holder of ${normalised}: ` +
          (error instanceof Error ? error.message : String(error)),
      );
      return null;
    });

    /*
     * The field mask applies to the holder too: MT5's name and email for a login
     * describe a person as surely as the CRM's do, and a role that may not read
     * one should not read the other.
     */
    const hidesNames =
      actor.fieldMask.includes('client.firstName') || actor.fieldMask.includes('client.lastName');
    const hidesEmails = actor.fieldMask.includes('client.email');

    let owner: { portalId?: number; name?: string; outsideTerritory: boolean } | null = null;
    // A row with no client is the MT5 sync's record of it (0166) — free to assign.
    if (owned && owned.userId !== null) {
      const [visible] = await this.db
        .select({ id: users.id, firstName: users.firstName, lastName: users.lastName })
        .from(users)
        .where(and(eq(users.id, owned.userId), clientScopePredicate(actor.clientScope, users.id)))
        .limit(1);
      owner = visible
        ? {
            portalId: visible.id,
            ...(hidesNames
              ? {}
              : { name: `${visible.firstName ?? ''} ${visible.lastName ?? ''}`.trim() }),
            outsideTerritory: false,
          }
        : { outsideTerritory: true };
    }

    const sellerIds = await this.products.productIdsForGroup(snapshot.group);
    const products = (await this.products.listProducts())
      .filter((product) => sellerIds.includes(product.id))
      .map((product) => ({ id: product.id, name: product.name }));

    const [currency] = await this.db
      .select({ code: currencies.code })
      .from(currencies)
      .where(eq(currencies.code, snapshot.currency))
      .limit(1);

    return {
      login: normalised,
      group: snapshot.group,
      currency: snapshot.currency,
      leverage: snapshot.leverage,
      balance: snapshot.balance,
      equity: snapshot.equity,
      credit: snapshot.credit,
      holderName: hidesNames ? null : holder?.name || null,
      holderEmail: hidesEmails ? null : holder?.email || null,
      environment: await this.products.environmentForGroup(snapshot.group),
      currencyKnown: Boolean(currency),
      products,
      owner,
      waitingDeals: await this.waitingDeals(normalised),
    };
  }

  /**
   * Record an MT5 login MT5 already has under a client, with its product.
   *
   * Refused, each with a sentence: a client outside the reader's territory (404,
   * like one that does not exist); a login the CRM already has (409 — moving an
   * account between clients re-attributes its commission and is not this
   * action); a login MT5 does not have (404); a currency the platform does not
   * hold; and a product that does not sell the group, or no product chosen when
   * several do — the same rule opening an account follows.
   */
  async linkMt5Account(
    input: { userId: number; login: string; productId?: string },
    actor: AuthenticatedAdmin,
  ) {
    assertActorCan(actor, 'trading.create', 'link an MT5 account');
    const login = normaliseLogin(input.login);

    const [client] = await this.db
      .select({ id: users.id })
      .from(users)
      .where(and(eq(users.id, input.userId), clientScopePredicate(actor.clientScope, users.id)))
      .limit(1);
    if (!client) throw new NotFoundError('Client not found.');
    this.assertBridge();

    const [owned] = await this.db
      .select({ id: tradingAccounts.id, userId: tradingAccounts.userId })
      .from(tradingAccounts)
      .where(eq(tradingAccounts.login, login))
      .limit(1);
    if (owned && owned.userId !== null) {
      throw new ConflictError(
        `MT5 account ${login} is already linked to a client. Moving an account between clients ` +
          're-attributes its commission and is not done from here.',
      );
    }

    // Stamped BEFORE the read: the mirror's rule is the moment MT5 was asked.
    const readAt = new Date();
    const snapshot = await this.bridge.getAccount(login);
    if (!snapshot) throw new NotFoundError(`MT5 has no account with login ${login}.`);

    const [currency] = await this.db
      .select({ code: currencies.code })
      .from(currencies)
      .where(eq(currencies.code, snapshot.currency))
      .limit(1);
    if (!currency) {
      throw new ValidationError(
        `MT5 account ${login} is in ${snapshot.currency}, which this platform does not hold. ` +
          'Add the currency first, then link the account.',
      );
    }

    const productId = await this.productForGroup(snapshot.group, input.productId);
    const environment = (await this.products.environmentForGroup(snapshot.group)) ?? 'live';

    /*
     * The MT5 sync may already hold the login as an account with NO client
     * (0166). Assigning it is an UPDATE of that row — guarded on `user_id IS
     * NULL`, so two operators assigning it at once cannot both win. Otherwise the
     * login is new to the CRM and is inserted, as before.
     */
    if (owned) {
      const [assigned] = await this.db
        .update(tradingAccounts)
        .set({
          userId: client.id,
          mt5Group: snapshot.group,
          productId,
          environment,
          currency: snapshot.currency,
          leverage: snapshot.leverage,
          updatedAt: new Date(),
        })
        .where(and(eq(tradingAccounts.id, owned.id), isNull(tradingAccounts.userId)))
        .returning({ id: tradingAccounts.id });
      if (!assigned) {
        throw new ConflictError(`MT5 account ${login} was just assigned by someone else.`);
      }
      /*
       * The balance only when this read is newer than the mirror's — the rule
       * every writer of it follows (the sweep may have read it after us).
       */
      await this.db
        .update(tradingAccounts)
        .set({ balance: snapshot.balance, credit: snapshot.credit, balanceSyncedAt: readAt })
        .where(
          and(
            eq(tradingAccounts.id, owned.id),
            sql`(${tradingAccounts.balanceSyncedAt} IS NULL OR ${tradingAccounts.balanceSyncedAt} < ${readAt})`,
          ),
        );
      return await this.linked(actor, {
        id: assigned.id,
        login,
        snapshot,
        productId,
        environment,
        clientId: client.id,
        assigned: true,
      });
    }

    let row: typeof tradingAccounts.$inferSelect;
    try {
      [row] = await this.db
        .insert(tradingAccounts)
        .values({
          userId: client.id,
          login,
          mt5Group: snapshot.group,
          productId,
          /*
           * From the catalogue when a product carries the group; LIVE when none
           * does — the conservative reading for an account holding real money
           * on the broker's server, and the one that lets its trades be decided
           * rather than silently skipped.
           */
          environment,
          currency: snapshot.currency,
          leverage: snapshot.leverage,
          // MT5's own figures, stamped with when they were read — never zero:
          // an existing account holds real money, and the mirror says so at once.
          balance: snapshot.balance,
          credit: snapshot.credit,
          balanceSyncedAt: readAt,
          status: 'active',
        })
        .returning();
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new ConflictError(`MT5 account ${login} was just linked by someone else.`);
      }
      throw error;
    }

    return await this.linked(actor, {
      id: row.id,
      login,
      snapshot,
      productId,
      environment,
      clientId: client.id,
      assigned: false,
    });
  }

  /** The audit row and the answer, for both kinds of link. */
  private async linked(
    actor: AuthenticatedAdmin,
    link: {
      id: string;
      login: string;
      snapshot: { group: string; currency: string; balance: string };
      productId: string | null;
      environment: 'live' | 'demo';
      clientId: number;
      /** True when the MT5 sync already held it with no client (0166). */
      assigned: boolean;
    },
  ) {
    const waitingDeals = await this.waitingDeals(link.login);
    this.audit.record(actor.id, 'trading.account_link', 'trading_account', link.id, {
      login: link.login,
      group: link.snapshot.group,
      environment: link.environment,
      productId: link.productId,
      clientId: link.clientId,
      waitingDeals,
      fromUnassigned: link.assigned,
    });

    return {
      id: link.id,
      login: link.login,
      group: link.snapshot.group,
      productId: link.productId,
      environment: link.environment,
      currency: link.snapshot.currency,
      balance: link.snapshot.balance,
      waitingDeals,
    };
  }

  /**
   * Set, change or clear the product an account's trades pay under — the
   * control a log line here has long told operators to use ("set one on the
   * account"). The product must sell the account's group. It applies to trades
   * NOT YET decided; accruals already written keep the terms that priced them.
   */
  async setAccountProduct(accountId: string, productId: string | null, actor: AuthenticatedAdmin) {
    assertActorCan(actor, 'trading.create', "set a trading account's product");
    const [account] = await this.db
      .select({
        id: tradingAccounts.id,
        login: tradingAccounts.login,
        group: tradingAccounts.mt5Group,
        productId: tradingAccounts.productId,
        userId: tradingAccounts.userId,
      })
      .from(tradingAccounts)
      .where(and(eq(tradingAccounts.id, accountId), accountInScope(actor)))
      .limit(1);
    if (!account) throw new NotFoundError('Trading account not found.');

    if (productId !== null) {
      if (!account.group) {
        throw new ValidationError(
          'This account has no MT5 group recorded, so no product can be checked against it.',
        );
      }
      if (!(await this.products.productSellsGroup(productId, account.group))) {
        throw new ValidationError(
          `That product does not sell the MT5 group "${account.group}". Choose one that carries ` +
            'this group, or attach the group to it first.',
        );
      }
    }

    await this.db
      .update(tradingAccounts)
      .set({ productId, updatedAt: new Date() })
      .where(eq(tradingAccounts.id, account.id));

    this.audit.record(actor.id, 'trading.account_product', 'trading_account', account.id, {
      login: account.login,
      clientId: account.userId,
      productId: { before: account.productId, after: productId },
    });
    return { id: account.id, productId };
  }

  /** Deals on a login ingested but not yet decided — what a link sets moving. */
  private async waitingDeals(login: string): Promise<number> {
    const [{ value }] = await this.db
      .select({ value: sql<number>`count(*)::int` })
      .from(mt5Deals)
      .where(and(eq(mt5Deals.login, login), isNull(mt5Deals.commissionProcessedAt)));
    return value;
  }

  private assertBridge(): void {
    assertBridgeConfigured(
      this.bridge,
      'The MT5 bridge is not configured on this deployment, so trading accounts cannot be ' +
        'opened or funded. Set MT5_BRIDGE_URL and MT5_BRIDGE_API_KEY.',
    );
  }
}

/**
 * The accounts a reader may act on: their territory's clients' — and, for a
 * reader who sees every client, the ones with no client yet (0166). The NULL
 * test is explicit because the predicate's intake branch is true for a NULL.
 */
function accountInScope(actor: AuthenticatedAdmin) {
  const scoped = clientScopePredicate(actor.clientScope, tradingAccounts.userId);
  return scoped ? and(isNotNull(tradingAccounts.userId), scoped) : undefined;
}

/** An MT5 login as digits, or a 400 naming the problem. */
function normaliseLogin(login: string): string {
  const trimmed = login.trim();
  if (!/^\d{1,20}$/.test(trimmed)) {
    throw new ValidationError('An MT5 login is a number, e.g. 5000123.');
  }
  // Leading zeros are not part of an MT5 login; stored as MT5 reports it.
  return String(BigInt(trimmed));
}
