import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { sql } from 'drizzle-orm';
import { ConfigService } from '@nestjs/config';
import { TransactionsService } from '../src/modules/payments/transactions.service';
import { CommissionService } from '../src/modules/ib/commission.service';
import { WalletService } from '../src/modules/wallet/wallet.service';
import { CurrenciesService } from '../src/modules/currencies/currencies.service';
import { MoneyLimits } from '../src/config/money-limits';
import { PaymentMethodsService } from '../src/modules/payments/payment-methods.service';
import { NotificationsService } from '../src/modules/notifications/notifications.service';
import { NotificationsStore } from '../src/store/notifications.store';
import type { AdminsStore } from '../src/store/admins.store';
import type { RolesStore } from '../src/store/roles.store';
import type { AdminClientScopesStore } from '../src/store/admin-client-scopes.store';
import type { ClientVisibilityService } from '../src/common/security/client-visibility.service';
import type { PaymentGateways } from '../src/modules/payments/payment-gateways.service';
import { AppSettingsStore } from '../src/store/app-settings.store';
import { auditStubAs } from './audit-stub';
import { emailStubAs } from './email-stub';
import { gatewayStub } from './gateway-stub';
import { transferExecutorStubAs, transfersStubAs } from './transfer-chain-stub';
import { startMoneyTestDb, stopMoneyTestDb, type MoneyTestContext } from './money-setup';

/*
 * A lease this instance always wins. Leader election has its own suite; a lease
 * mocked to refuse here would make every case pass by never running the job.
 */
const alwaysLeads = () =>
  ({ run: (_n: string, _t: number, work: () => Promise<void>) => work() }) as never;

/**
 * The domain hooks, against real Postgres — the half a stub cannot answer.
 *
 * What is pinned here:
 *  - a withdrawal decision and its bell row COMMIT TOGETHER — a decision whose
 *    notify fails is a decision that did not happen, never a decision the
 *    client was not told about;
 *  - a replayed deposit settlement converges on ONE `deposit.succeeded` row;
 *  - the hourly commission confirm loop, re-run, leaves one row per accrual —
 *    at-least-once delivery is the standing assumption (§9).
 */

let ctx: MoneyTestContext;
let wallets: WalletService;
let transactions: TransactionsService;
let commissions: CommissionService;
let store: NotificationsStore;
let dispatch: NotificationsService;
let gateway: ReturnType<typeof gatewayStub>;

const ADMIN_ID = '00000000-0000-4000-8000-00000000000a';

beforeAll(async () => {
  ctx = await startMoneyTestDb();
  wallets = new WalletService(ctx.db);
  store = new NotificationsStore(ctx.db);
  // Real store behind the real service; the admin fan-out half is exercised in
  // notifications-fanout.spec.ts, so the directory stores can be empty fakes.
  dispatch = new NotificationsService(
    store,
    { findAll: vi.fn().mockResolvedValue({ rows: [], total: 0 }) } as unknown as AdminsStore,
    {} as unknown as RolesStore,
    {} as unknown as AdminClientScopesStore,
    {} as unknown as ClientVisibilityService,
    alwaysLeads(),
  );

  const currencies = new CurrenciesService(ctx.db, auditStubAs());
  gateway = gatewayStub();
  transactions = new TransactionsService(
    wallets,
    ctx.db,
    new MoneyLimits(new ConfigService()),
    new PaymentMethodsService(
      ctx.db,
      currencies,
      auditStubAs(),
      gateway as unknown as PaymentGateways,
      new MoneyLimits(new ConfigService()),
    ),
    currencies,
    gateway as unknown as PaymentGateways,
    new ConfigService(),
    emailStubAs(),
    dispatch,
    transfersStubAs(),
    transferExecutorStubAs(),
  );
  /*
   * The maturation window is switched OFF for this spec, through the real
   * config path rather than a special argument.
   *
   * These tests accrue and confirm in the same breath, and the default 24-hour
   * hold would leave every accrual pending — the suite would fail against a
   * system behaving exactly as designed. Setting the variable is what a
   * deployment that pays immediately does, so this exercises a supported
   * configuration rather than a test-only door.
   *
   * What the window itself does is covered in `commission-hold-window.spec.ts`.
   * (This comment used to name `commission.spec.ts`, which has never mentioned
   * the window — the rule deciding when a partner's money becomes spendable was
   * asserted nowhere at all.)
   */
  /*
   * The maturation window cannot be switched OFF any more (0113): it is a
   * setting with a 60-second floor, not `IB_COMMISSION_HOLD_HOURS=0`.
   *
   * So these cases BACKDATE their accruals past the window instead of removing
   * it. That is the better fixture anyway — it exercises the real predicate
   * (`created_at <= now() - interval`) rather than collapsing it to a
   * comparison against zero, and the window's own behaviour stays pinned in
   * `commission-hold-window.spec.ts`.
   */
  await ctx.db.execute(sql`
      INSERT INTO trading_settings (id, ib_commission_interval_seconds) VALUES (true, 60)
      ON CONFLICT (id) DO UPDATE SET ib_commission_interval_seconds = 60
    `);
  /*
   * A REAL settings store on the test database. With no row written it reports
   * the column defaults, so the payout ceiling is the shipped 100% — which is
   * what a fresh deployment has, and therefore what these tests should run
   * against.
   *
   * The comment here used to say "the broker cap is the default 50%". That was
   * `ib_max_revenue_share_pct`, removed in 0103, and the sentence outlived it by
   * three migrations — describing a control that no longer existed, on a line
   * that had stopped passing a settings store at all.
   */
  commissions = new CommissionService(
    ctx.db,
    wallets,
    dispatch,
    new AppSettingsStore(ctx.db),
    /* The per-run payout summary email (0114). Stubbed: this suite is about
       the money, and the send is fire-and-forget by contract. */
    emailStubAs(),
  );
}, 120_000);

afterAll(async () => {
  await stopMoneyTestDb(ctx);
});

async function makeFundedClient(email: string, balance = '1000'): Promise<string> {
  const { rows } = await ctx.db.execute<{ id: string }>(sql`
    INSERT INTO users (email, password_hash, first_name, last_name, verification_level, email_verified)
    VALUES (${email}, 'x', 'Test', 'Client', 1, true)
    RETURNING id
  `);
  const userId = rows[0].id;
  await wallets.post({
    userId,
    currency: 'USD',
    amount: balance,
    entryType: 'deposit',
    referenceType: 'transaction',
    referenceId: `seed-${userId}`,
  });
  return userId;
}

async function rowsFor(userId: string, kind: string) {
  const page = await store.findPage({ kind: 'client', id: userId }, { limit: 100 });
  return page.items.filter((n) => n.kind === kind);
}

beforeEach(async () => {
  await ctx.db.execute(sql`DELETE FROM notifications`);
  await ctx.db.execute(sql`DELETE FROM ib_accruals`);
  /* Batches sit between the accruals and the wallets in FK order (0116). */
  await ctx.db.execute(sql`DELETE FROM ib_accrual_batches`);
  await ctx.db.execute(sql`DELETE FROM transfers`);
  await ctx.db.execute(sql`DELETE FROM transactions`);
  await ctx.db.execute(sql`DELETE FROM ledger_entries`);
  await ctx.db.execute(sql`DELETE FROM wallets`);
  await ctx.db.execute(sql`DELETE FROM ib_accounts`);
  await ctx.db.execute(sql`DELETE FROM users`);
});

describe('withdrawal decisions and their bell rows are one commit', () => {
  it('an approval writes the row with the state change', async () => {
    const userId = await makeFundedClient('approve-notify@test.local');
    const row = await transactions.requestWithdrawal({
      userId,
      currency: 'USD',
      amount: '100',
      destination: '+961 3 123 456',
      methodKey: 'whish',
    });

    // The same callback shape AdminMoneyService passes.
    await transactions.approve(
      row.id,
      ADMIN_ID,
      { awaitsProviderPayout: false },
      async (tx, approved) => {
        await dispatch.notify(
          {
            recipient: { kind: 'client', id: approved.userId },
            kind: 'withdrawal.approved',
            params: {
              transactionId: approved.id,
              amount: approved.amount,
              currency: approved.currency,
            },
          },
          tx,
        );
      },
    );

    const bells = await rowsFor(userId, 'withdrawal.approved');
    expect(bells).toHaveLength(1);
    expect(bells[0].params['amount']).toBe('100.00000000');
  });

  it('a decision whose transaction fails leaves NEITHER the state change nor the row', async () => {
    const userId = await makeFundedClient('rollback-notify@test.local');
    const row = await transactions.requestWithdrawal({
      userId,
      currency: 'USD',
      amount: '100',
      destination: '+961 3 123 456',
      methodKey: 'whish',
    });

    await expect(
      transactions.approve(
        row.id,
        ADMIN_ID,
        { awaitsProviderPayout: false },
        async (tx, approved) => {
          await dispatch.notify(
            {
              recipient: { kind: 'client', id: approved.userId },
              kind: 'withdrawal.approved',
              params: {},
            },
            tx,
          );
          throw new Error('audit write failed after the notify');
        },
      ),
    ).rejects.toThrow('audit write failed');

    // The state change rolled back...
    const { rows } = await ctx.db.execute<{ state: string }>(
      sql`SELECT state FROM transactions WHERE id = ${row.id}`,
    );
    expect(rows[0].state).toBe('pending');
    // ...and so did the bell row: the client was never told about a decision
    // that did not happen.
    expect(await rowsFor(userId, 'withdrawal.approved')).toHaveLength(0);
  });
});

describe('deposit settlement', () => {
  async function seedPendingDeposit(userId: string, reference: string): Promise<string> {
    const wallet = await wallets.getOrCreateWallet(userId, 'USD');
    const { rows } = await ctx.db.execute<{ id: string }>(sql`
      INSERT INTO transactions (user_id, wallet_id, direction, amount, currency, state, provider, provider_ref, rival_external_id)
      VALUES (${userId}, ${wallet.id}, 'deposit', '250.00000000', 'USD', 'pending', 'whish', ${reference},
              ${'rx-' + reference})
      RETURNING id
    `);
    return rows[0].id;
  }

  it('a replayed settlement callback converges on ONE deposit.succeeded row', async () => {
    const userId = await makeFundedClient('deposit-replay@test.local');
    await seedPendingDeposit(userId, 'replay-ref-1');
    gateway.checkPayment.mockResolvedValue({ settled: true, paid: true, rawStatus: 'paid' });

    expect((await transactions.settleGatewayDeposit('whish', 'replay-ref-1')).state).toBe(
      'success',
    );
    // The replay — at-least-once delivery is the standing assumption.
    expect((await transactions.settleGatewayDeposit('whish', 'replay-ref-1')).state).toBe(
      'success',
    );

    expect(await rowsFor(userId, 'deposit.succeeded')).toHaveLength(1);
  });

  it('a failed settlement writes one deposit.failed row', async () => {
    const userId = await makeFundedClient('deposit-failed@test.local');
    await seedPendingDeposit(userId, 'failed-ref-1');
    gateway.checkPayment.mockResolvedValue({ settled: true, paid: false, rawStatus: 'expired' });

    expect((await transactions.settleGatewayDeposit('whish', 'failed-ref-1')).state).toBe(
      'failure',
    );
    expect((await transactions.settleGatewayDeposit('whish', 'failed-ref-1')).state).toBe(
      'failure',
    );

    // The dispatch is post-write and fire-and-forget; give it a beat to land.
    await vi.waitFor(async () => {
      expect(await rowsFor(userId, 'deposit.failed')).toHaveLength(1);
    });
  });
});

describe('commission confirmation', () => {
  it('a re-run of the confirm loop leaves one bell row per accrual', async () => {
    const partnerId = await makeFundedClient('partner-notify@test.local');
    const clientId = await makeFundedClient('referred-notify@test.local');
    const sourceId = '00000000-0000-4000-8000-0000000000cc';
    await ctx.db.execute(sql`
      INSERT INTO ib_accruals (ib_user_id, client_user_id, source_type, source_id, depth,
                               rate_value, base_amount, amount, currency)
      VALUES (${partnerId}, ${clientId}, 'transaction', ${sourceId}, 1,
              '70.0000', '250.00000000', '5.00000000', 'USD')
    `);

    /* Past the 60s window — see the note in the setup above. */
    await ctx.db.execute(sql`UPDATE ib_accruals SET created_at = now() - interval '10 minutes'`);
    const first = await commissions.confirmPending();
    expect(first.confirmed).toBe(1);
    // The re-run: nothing pending, nothing double-notified.
    /* Past the 60s window — see the note in the setup above. */
    await ctx.db.execute(sql`UPDATE ib_accruals SET created_at = now() - interval '10 minutes'`);
    const second = await commissions.confirmPending();
    expect(second.confirmed).toBe(0);

    const bells = await rowsFor(partnerId, 'commission.confirmed');
    expect(bells).toHaveLength(1);
    expect(bells[0].params['amount']).toBe('5.00000000');
  });
});
