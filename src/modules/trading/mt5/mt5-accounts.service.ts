import { Inject, Injectable, Logger } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { and, eq, inArray } from 'drizzle-orm';
import { DRIZZLE_DB } from '../../../database/database.module';
import type { Db } from '../../../database/db';
import { tradingAccounts, users } from '../../../database/schema';
import { Mt5BridgeClient } from './mt5-bridge.client';
import { AdminAuditService } from '../../admin/admin-audit.service';
import { EmailService } from '../../email/email.service';
import { assertActorCan } from '../../../common/security/actor';
import { clientScopePredicate } from '../../../common/security/client-scope';
import type { AuthenticatedAdmin } from '../../admin/guards/admin.guard';
import { NotFoundError, ValidationError } from '../../../common/errors/domain-errors';
import { AppSettingsStore } from '../../../store/app-settings.store';
import { ConfigService } from '@nestjs/config';
import { tradingTermsFrom } from '../../../common/trading-terms';

/**
 * How many accounts one live-balance request may cover.
 *
 * The console's default page size, so a page load is one request. Larger pages
 * fall back to the cached column for the overflow rather than being refused —
 * see the controller.
 */
const MAX_LIVE_BALANCES = 25;

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
    private readonly config: ConfigService,
  ) {}

  /**
   * The operator's trading terms, read fresh on each create.
   *
   * Not cached. A create is already several network round trips to the broker,
   * so one indexed read of a single-row table costs nothing measurable — and an
   * operator who lowers a cap because of an abuse incident should not have to
   * wait out a TTL or restart the process for it to take effect.
   */
  private async terms() {
    return tradingTermsFrom(
      await this.settings.getTrading(),
      this.config.get<string>('MT5_CLIENT_LEVERAGES'),
    );
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

    return {
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

    const created = await this.bridge.createAccount({
      group: input.group,
      // The client's own name when they did not choose one — that is what MT5
      // expects in this field and what makes a row in the manager terminal
      // identifiable.
      name: input.name?.trim() || `${client.firstName} ${client.lastName}`.trim(),
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
   * Credit or debit a trading account on MT5.
   *
   * ## This does NOT touch a wallet
   *
   * It is a dealer operation: money appears on, or leaves, the MT5 account with
   * no corresponding movement in the CRM ledger. That is the right shape for
   * corrections, bonuses and manual settlement, and the WRONG shape for a
   * client funding their account — that is a transfer, has two legs, and lives
   * in `TransfersService`.
   *
   * Because it is one-sided it is gated on its own permissions, separately in
   * each direction: crediting is giving away the broker's money and debiting is
   * taking a client's.
   */
  async adjustBalance(
    input: {
      accountId: string;
      amount: string;
      direction: 'deposit' | 'withdraw';
      comment: string;
    },
    actor: AuthenticatedAdmin,
  ) {
    assertActorCan(
      actor,
      input.direction === 'deposit' ? 'trading.deposit' : 'trading.withdraw',
      `${input.direction} on a trading account`,
    );

    // Scope on the OWNING client, BEFORE the bridge: a scoped admin cannot move
    // money on an account whose client is outside their territory — the
    // predicate joins the WHERE, so an out-of-scope account is a 404, never a
    // 403 (D-45), and the refusal does not depend on MT5 being reachable.
    const [account] = await this.db
      .select()
      .from(tradingAccounts)
      .where(
        and(
          eq(tradingAccounts.id, input.accountId),
          clientScopePredicate(actor.clientScope, tradingAccounts.userId),
        ),
      )
      .limit(1);

    if (!account) throw new NotFoundError('Trading account not found.');
    this.assertBridge();
    if (!account.login) {
      throw new ValidationError('That account has no MT5 login, so it cannot be funded.');
    }
    if (account.status !== 'active') {
      throw new ValidationError(`That account is ${account.status} and takes no money.`);
    }

    /*
     * The SIGN is applied here, once, from the direction — the caller sends a
     * positive amount and says which way.
     *
     * The bridge deliberately does not reinterpret signs, so if this were left
     * to the caller a withdrawal sent as a positive number would be a silent
     * deposit. Requiring a positive amount and deriving the sign makes that
     * mistake unrepresentable rather than merely unlikely.
     */
    if (!/^\d+(\.\d{1,8})?$/.test(input.amount) || Number.parseFloat(input.amount) === 0) {
      throw new ValidationError('Amount must be a positive decimal.');
    }
    const signed = input.direction === 'withdraw' ? `-${input.amount}` : input.amount;

    /*
     * A fresh key per attempt, and that is correct here.
     *
     * The bridge's idempotency store exists so that ITS OWN retry of a timed-out
     * call does not credit twice. It is not a guard against an operator clicking
     * twice — two clicks are two intended operations as far as this layer can
     * tell, and inventing a key from the amount would silently swallow a genuine
     * second deposit of the same size.
     */
    const idempotencyKey = randomUUID();

    const result = await this.bridge.balance({
      login: account.login,
      amount: signed,
      type: 'balance',
      comment: input.comment,
      idempotencyKey,
    });

    // Refresh the cached balance from MT5 rather than adding locally: the
    // client may have been trading while this ran, and our arithmetic would
    // overwrite the truth with a stale guess.
    const snapshot = await this.bridge.getAccount(account.login).catch(() => null);
    if (snapshot) {
      await this.db
        .update(tradingAccounts)
        .set({ balance: snapshot.balance, updatedAt: new Date() })
        .where(eq(tradingAccounts.id, account.id));
    }

    this.audit.record(
      actor.id,
      input.direction === 'deposit' ? 'trading.deposit' : 'trading.withdraw',
      'trading_account',
      account.id,
      {
        login: account.login,
        amount: input.amount,
        dealId: String(result.dealId),
        replayed: result.replayed,
        comment: input.comment,
      },
    );

    this.logger.log(
      `${input.direction} ${input.amount} on MT5 ${account.login} by ${actor.email} -> deal ${result.dealId}`,
    );

    return {
      dealId: String(result.dealId),
      replayed: result.replayed,
      balance: snapshot?.balance ?? null,
    };
  }

  /**
   * Live balances for a page of accounts, keyed by account id.
   *
   * ## Why the list needs this at all
   *
   * `trading_accounts.balance` is a CACHE and nothing refreshes it. It moves
   * when the console deposits and at no other time — a client's own trading
   * changes the real figure every second and MT5 never tells us. So the column
   * is not merely stale, it is stale in a way that gets worse the more the
   * account is used, and it reads as authoritative.
   *
   * That is not hypothetical: the accounts screen showed ten accounts at
   * $0.00, which was the honest content of a column nobody had ever written to.
   *
   * ## Bounded on purpose
   *
   * One bridge call per account, so this takes the page the operator is looking
   * at and refuses anything larger. An unbounded version invited a caller to
   * ask for every account on the platform and turned one page load into
   * thousands of round trips to the broker.
   *
   * ## A failure here is not a failure of the page
   *
   * An account MT5 will not answer for is simply absent from the result, and
   * the console falls back to the cached figure with a label saying so. The
   * alternative — failing the whole request — would blank a working table
   * because one account is unreadable.
   */
  async liveBalances(accountIds: string[], actor: AuthenticatedAdmin) {
    assertActorCan(actor, 'trading.view', 'read live MT5 balances');

    if (accountIds.length === 0) return {};
    if (accountIds.length > MAX_LIVE_BALANCES) {
      throw new ValidationError(
        `Ask for at most ${MAX_LIVE_BALANCES} accounts at a time; this is one call to MT5 each.`,
      );
    }

    // Not an error when the bridge is unconfigured: the page still works off
    // the cache, and every row falling back is the correct rendering of "we
    // cannot reach MT5 right now".
    if (!this.bridge.isConfigured) return {};

    // Scope on the owning client: out-of-scope account ids simply do not come
    // back, the same as ids that name no account — a scoped desk reads live
    // balances only for its own territory's accounts, even though the ids
    // arrive in the request body rather than from a list it already filtered.
    const rows = await this.db
      .select({ id: tradingAccounts.id, login: tradingAccounts.login })
      .from(tradingAccounts)
      .where(
        and(
          inArray(tradingAccounts.id, accountIds),
          clientScopePredicate(actor.clientScope, tradingAccounts.userId),
        ),
      );

    const balances: Record<string, string> = {};

    /*
     * Sequential, not Promise.all.
     *
     * The bridge serialises every call behind one lock anyway — the MT5 session
     * is a single socket — so firing twenty-five at once buys nothing and just
     * queues them inside the bridge where this service cannot see or bound the
     * wait.
     */
    for (const row of rows) {
      if (!row.login) continue;
      try {
        const snapshot = await this.bridge.getAccount(row.login);
        if (snapshot) balances[row.id] = snapshot.balance;
      } catch (error) {
        this.logger.warn(
          `Could not read the live balance for MT5 ${row.login}: ` +
            `${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }

    return balances;
  }

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
