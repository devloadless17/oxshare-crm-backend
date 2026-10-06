import { Inject, Injectable, Logger } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import Decimal from 'decimal.js';
import { and, eq, ne, sql } from 'drizzle-orm';
import { DRIZZLE_DB } from '../../../database/database.module';
import type { Db } from '../../../database/db';
import { tradingAccounts, users } from '../../../database/schema';
import { Mt5BridgeClient, assertBridgeConfigured } from './mt5-bridge.client';
import { EmailService } from '../../email/email.service';
import { requestLocale } from '../../../common/i18n/locale';
import {
  AccountNameTakenError,
  ConflictError,
  NotFoundError,
  ValidationError,
} from '../../../common/errors/domain-errors';
import { Mt5AccountSyncService } from './mt5-account-sync.service';
import { Mt5AccountsService } from './mt5-accounts.service';
import { violatesConstraint } from '../../../common/errors/pg-violation';
import { ProductsStore } from '../../../store/products.store';

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
 * A CLIENT's own MT5 accounts: open, rename, reset the password, top up a demo.
 *
 * Split out of `Mt5AccountsService` (1600 lines mixing back-office provisioning,
 * linking, scoping, live reads and client self-service). The back office and
 * the client share the group/product/naming rules, which stay on
 * `Mt5AccountsService` and are called from here, so the two can never decide
 * them differently.
 */
@Injectable()
export class Mt5OwnAccountsService {
  private readonly logger = new Logger(Mt5OwnAccountsService.name);

  constructor(
    @Inject(DRIZZLE_DB) private readonly db: Db,
    private readonly bridge: Mt5BridgeClient,
    private readonly email: EmailService,
    private readonly accountSync: Mt5AccountSyncService,
    private readonly accounts: Mt5AccountsService,
    private readonly products: ProductsStore,
  ) {}

  /**
   * A CAP on how many accounts a client may hold under one product (0201).
   *
   * Every account is a real row on the broker's server that somebody has to
   * administer, and this endpoint is reachable by anyone with a session — a
   * script could otherwise open thousands. The cap is the PRODUCT's
   * (`max_accounts_per_client`); it replaced one cap per environment. Closed
   * accounts do not count (`ProductsStore.accountsHeld`).
   *
   * Not a lock: two opens racing past it can both pass, as with the cap it
   * replaced. The price is one account over a cap, never money.
   */
  private async assertUnderProductCap(userId: number, productId: string | null): Promise<void> {
    // Unreachable from self-service (the offer names a product); nothing to count against.
    if (!productId) return;
    const product = (await this.products.listProducts()).find((row) => row.id === productId);
    if (!product) return;
    const held = (await this.products.accountsHeld(userId)).get(productId) ?? 0;
    if (held >= product.maxAccountsPerClient) {
      throw new ValidationError(
        `You already have ${held} '${product.name}' account${held === 1 ? '' : 's'}, the most ` +
          'one client may hold. Contact support if you need another.',
      );
    }
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
    userId: number;
    environment: 'live' | 'demo';
    group: string;
    /**
     * The product the client chose, from the offered pairs (0142). Resolved by
     * the controller, so it is always one of the products actually offered.
     */
    productId?: string;
    /** Validated against the offered ladder by the caller. */
    leverage?: number;
    /**
     * IGNORED (owner, 29 Sep 2026): the client does not name the account — see
     * `autoAccountName`. Kept on the input so a caller that still sends it is
     * not refused.
     */
    name?: string;
    /** DEMO only — refused on a live account rather than ignored. */
    startingBalance?: string;
  }) {
    assertBridgeConfigured(
      this.bridge,
      'The MT5 bridge is not configured on this deployment, so trading accounts cannot be ' +
        'opened or funded. Set MT5_BRIDGE_URL and MT5_BRIDGE_API_KEY.',
    );

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

    const terms = await this.accounts.terms();

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
     * The client does NOT name the account (owner, 29 Sep 2026): it is named
     * "First Last" for their first, "First Last-2", "-3"… after — see
     * `autoAccountName`. Derived before the bridge call, so MT5 and the CRM
     * hold the same name from the start.
     */
    const accountName = await this.accounts.autoAccountName(client);

    // Before the bridge, for the reason the admin path gives.
    const productId = await this.accounts.productForGroup(input.group, input.productId);
    await this.assertUnderProductCap(client.id, productId);

    const created = await this.bridge.createAccount({
      group: input.group,
      // The holder name in the manager terminal — the same one the CRM stores.
      name: accountName,
      email: client.email,
      country: client.country ?? undefined,
      phone: client.phone ?? undefined,
      leverage: input.leverage,
      externalId: String(client.id),
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

    const ownProductId = await this.accounts.recordedProduct(created.group, input.group, productId);
    const ownEnvironment = await this.accounts.environmentForGroup(
      created.group,
      input.environment,
      created.login,
    );
    let inserted: { result: typeof tradingAccounts.$inferSelect; name: string };
    try {
      inserted = await this.accounts.insertNamed(
        client,
        accountName,
        String(created.login),
        (name) =>
          this.db
            .insert(tradingAccounts)
            .values({
              userId: client.id,
              login: String(created.login),
              // Stored so the PORTAL can label this account without asking the
              // bridge — the same string MT5 holds as the holder name.
              name,
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
              productId: ownProductId,
              /* From the group MT5 confirmed, not from the request — see the helper. */
              environment: ownEnvironment,
              currency: created.currency,
              leverage: created.leverage,
              balance: snapshot?.balance ?? '0',
              status: 'active',
            })
            .returning()
            .then((rows) => rows[0]),
      );
    } catch (error) {
      /*
       * MT5 issued a login the CRM already holds. The account now exists on MT5
       * with no CRM row, so the desk must reconcile it by hand: say so LOUDLY, with
       * the login and the client, and tell the client something true rather than
       * a bare "That record already exists" (found live, 3 Oct 2026, when a
       * restarted simulator reissued a login). Real MT5 never reuses a login.
       */
      if (violatesConstraint(error, 'trading_accounts_login_uq')) {
        this.logger.error(
          `MT5 issued login ${created.login} for client ${client.id}, but the CRM already ` +
            'holds that login. The new MT5 account has NO CRM record — reconcile it by hand.',
        );
        throw new ConflictError(
          'Your account could not be registered. Our team has been alerted and will ' +
            'finish setting it up; you do not need to try again.',
        );
      }
      throw error;
    }
    const { result: row, name: storedName } = inserted;

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
      storedName,
      // What MT5 holds, not what was asked for: if funding failed this is '0'
      // and the mail correctly omits the line rather than promising money that
      // is not there.
      snapshot?.balance ?? '0',
      // The client's own request: the language they are reading the portal in.
      requestLocale(),
    );

    /*
     * NO bell, on either side — the owner's notification rules (migration 0140).
     *
     * The CLIENT just opened this account themselves and is looking at it: the
     * response names the mailbox the credentials went to, and the account is on
     * their accounts list from this moment. A bell row repeating that is an
     * echo of their own click, which is what made the portal's bell look full.
     * The credentials email above is the durable record, and it is unchanged.
     *
     * The ADMINS are not told either. Self-service opening completes at once
     * with no approval step, so there is nothing for an operator to do — and an
     * admin notification is a task, never information.
     */

    return {
      id: row.id,
      login: String(created.login),
      name: storedName,
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
  private async ownAccount(userId: number, accountId: string) {
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
  async resetOwnAccountPassword(input: { userId: number; accountId: string }) {
    assertBridgeConfigured(
      this.bridge,
      'The MT5 bridge is not configured on this deployment, so trading accounts cannot be ' +
        'opened or funded. Set MT5_BRIDGE_URL and MT5_BRIDGE_API_KEY.',
    );

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
      requestLocale(),
    );

    return { login: account.login, credentialsSentTo: account.email };
  }

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
  private async assertNameFree(userId: number, name: string, exceptAccountId?: string) {
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
  async renameOwnAccount(input: { userId: number; accountId: string; name: string }) {
    assertBridgeConfigured(
      this.bridge,
      'The MT5 bridge is not configured on this deployment, so trading accounts cannot be ' +
        'opened or funded. Set MT5_BRIDGE_URL and MT5_BRIDGE_API_KEY.',
    );

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
  async fundOwnDemoAccount(input: { userId: number; accountId: string; amount: string }) {
    assertBridgeConfigured(
      this.bridge,
      'The MT5 bridge is not configured on this deployment, so trading accounts cannot be ' +
        'opened or funded. Set MT5_BRIDGE_URL and MT5_BRIDGE_API_KEY.',
    );

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

    const terms = await this.accounts.terms();
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
}
