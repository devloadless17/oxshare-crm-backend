import { Inject, Injectable, Logger } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { and, eq, inArray } from 'drizzle-orm';
import { DRIZZLE_DB } from '../../../database/database.module';
import type { Db } from '../../../database/db';
import { tradingAccounts, users } from '../../../database/schema';
import { Mt5BridgeClient } from './mt5-bridge.client';
import { AdminAuditService } from '../../admin/admin-audit.service';
import { assertActorCan } from '../../../common/security/actor';
import type { AuthenticatedAdmin } from '../../admin/guards/admin.guard';
import { NotFoundError, ValidationError } from '../../../common/errors/domain-errors';

/**
 * How many accounts one live-balance request may cover.
 *
 * The console's default page size, so a page load is one request. Larger pages
 * fall back to the cached column for the overflow rather than being refused —
 * see the controller.
 */
const MAX_LIVE_BALANCES = 25;

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
  ) {}

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
     * The passwords are returned ONCE and stored nowhere — the same contract
     * the API-key screen uses, for the same reason: a credential that can be
     * re-read is a credential that leaks twice. The console must show them now
     * or never.
     */
    return {
      id: row.id,
      login: String(created.login),
      group: created.group,
      currency: created.currency,
      leverage: created.leverage,
      environment: input.environment,
      masterPassword: created.masterPassword,
      investorPassword: created.investorPassword,
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
    this.assertBridge();

    const [account] = await this.db
      .select()
      .from(tradingAccounts)
      .where(eq(tradingAccounts.id, input.accountId))
      .limit(1);

    if (!account) throw new NotFoundError('Trading account not found.');
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

    const rows = await this.db
      .select({ id: tradingAccounts.id, login: tradingAccounts.login })
      .from(tradingAccounts)
      .where(inArray(tradingAccounts.id, accountIds));

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
    this.assertBridge();

    const [account] = await this.db
      .select()
      .from(tradingAccounts)
      .where(and(eq(tradingAccounts.id, accountId)))
      .limit(1);

    if (!account) throw new NotFoundError('Trading account not found.');
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
