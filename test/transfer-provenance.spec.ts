import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { sql } from 'drizzle-orm';
import { TransfersService } from '../src/modules/payments/transfers.service';
import { TransactionQueries } from '../src/modules/payments/queries/transaction-queries';
import type { PaymentProviderRegistry } from '../src/modules/payments/providers/payment-provider-registry';
import { ConflictError, ValidationError } from '../src/common/errors/domain-errors';
import { WalletService } from '../src/modules/wallet/wallet.service';
import { CurrenciesService } from '../src/modules/currencies/currencies.service';
import { auditStubAs } from './audit-stub';
import { notificationsStub } from './notifications-stub';
import { startMoneyTestDb, stopMoneyTestDb, type MoneyTestContext } from './money-setup';

/**
 * A TRANSFER RECORDS WHERE ITS MONEY CAME FROM (0226), AND A PAYMENT WHO APPROVED IT AND WHY (0227).
 *
 * The buyer's accountants asked which account every transfer moved money from and to, and where the
 * money on a trading account came from. Nothing on the row said so: a deposit sent straight to an
 * account chained a transfer that read exactly like the client moving money, and the desk's who and
 * why lived only in the audit log. Pinned here, against real Postgres:
 *
 *  - every writer states its provenance, and the row carries it;
 *  - a deposit funds at most ONE transfer — a retried or racing chain converges on it, one hold;
 *  - the database refuses a source that is not this client's settled deposit of the same amount,
 *    an origin that does not fit the direction, and any later change of provenance;
 *  - a writer that states no origin (the previous build) gets it worked out from its ref;
 *  - the backfill classifies history exactly and is a no-op the second time;
 *  - a client's own history no longer carries the deciding admin's id.
 */
let ctx: MoneyTestContext;
let transfers: TransfersService;
let wallets: WalletService;
const ADMIN = '00000000-0000-4000-8000-0000000000ad';

beforeAll(async () => {
  ctx = await startMoneyTestDb();
  wallets = new WalletService(ctx.db);
  transfers = new TransfersService(
    wallets,
    new CurrenciesService(ctx.db, auditStubAs()),
    ctx.db,
    notificationsStub(),
  );
}, 120_000);

afterAll(async () => {
  await stopMoneyTestDb(ctx);
});

beforeEach(async () => {
  await ctx.db.execute(sql`DELETE FROM transfers`);
  await ctx.db.execute(sql`DELETE FROM transactions`);
  await ctx.db.execute(sql`TRUNCATE ledger_entries CASCADE`);
  await ctx.db.execute(sql`DELETE FROM trading_accounts`);
  await ctx.db.execute(sql`DELETE FROM wallets`);
  await ctx.db.execute(sql`DELETE FROM users`);
});

const q = async <T = Record<string, unknown>>(text: string, params: unknown[] = []) =>
  (await ctx.pool.query(text, params)).rows as T[];

async function client(email: string, balance = '1000'): Promise<number> {
  const [{ id }] = await q<{ id: number }>(
    `INSERT INTO users (email, password_hash, first_name, last_name, verification_level, email_verified)
     VALUES ($1, 'x', 'Test', 'Client', 1, true) RETURNING id`,
    [email],
  );
  await wallets.post({
    userId: id,
    currency: 'USD',
    amount: balance,
    entryType: 'deposit',
    referenceType: 'transaction',
    referenceId: `seed-${id}`,
  });
  return id;
}

async function account(userId: number): Promise<string> {
  const [{ id }] = await q<{ id: string }>(
    `INSERT INTO trading_accounts (user_id, environment, currency, balance, status, login)
     VALUES ($1, 'live', 'USD', '0', 'active', $2) RETURNING id`,
    [userId, String(7_000_000 + userId)],
  );
  return id;
}

/** A settled deposit row — the money a chain or a desk credit moves on. */
async function deposit(
  userId: number,
  amount: string,
  opts: { provider?: string; ref?: string; toAccount?: string; settledAt?: string } = {},
): Promise<string> {
  const [{ id: walletId }] = await q<{ id: string }>(
    `SELECT id FROM wallets WHERE user_id = $1 AND currency = 'USD'`,
    [userId],
  );
  const manual = (opts.provider ?? 'manual_test') === 'manual_admin';
  const [{ id }] = await q<{ id: string }>(
    `INSERT INTO transactions (user_id, wallet_id, direction, amount, currency, state, provider,
                               provider_ref, provider_code, channel_code, provider_environment,
                               destination_trading_account_id, settled_at)
     VALUES ($1, $2, 'deposit', $3, 'USD', 'success', $4, $5, 'manual', $6, 'live', $7,
             COALESCE($8::timestamptz, now()))
     RETURNING id`,
    [
      userId,
      walletId,
      amount,
      opts.provider ?? 'manual_test',
      opts.ref ?? `ref-${Math.random()}`,
      manual ? 'adjustment' : 'offline',
      opts.toAccount ?? null,
      opts.settledAt ?? null,
    ],
  );
  return id;
}

const transferRow = async (id: string) =>
  (
    await q<{
      origin: string;
      source_transaction_id: string | null;
      requested_by_admin_id: string | null;
      desk_reason: string | null;
      request_ref: string | null;
    }>(
      `SELECT origin, source_transaction_id, requested_by_admin_id, desk_reason, request_ref
         FROM transfers WHERE id = $1`,
      [id],
    )
  )[0];

const onHold = async (userId: number) =>
  (await q<{ on_hold: string }>(`SELECT on_hold FROM wallets WHERE user_id = $1`, [userId]))[0]
    .on_hold;

describe('every writer states where the money came from', () => {
  it('a client transfer is the client’s, with no source and no desk member', async () => {
    const userId = await client('p-client@test.local');
    const tradingAccountId = await account(userId);
    const row = await transfers.request({
      userId,
      tradingAccountId,
      direction: 'wallet_to_account',
      amount: '10.00',
      currency: 'USD',
      provenance: { origin: 'client' },
    });
    expect(await transferRow(row.id)).toMatchObject({
      origin: 'client',
      source_transaction_id: null,
      requested_by_admin_id: null,
      request_ref: null,
    });
  });

  it('a deposit chained to its account names the deposit, keyed on it — and converges on ONE transfer and ONE hold', async () => {
    const userId = await client('p-chain@test.local');
    const tradingAccountId = await account(userId);
    const depositId = await deposit(userId, '50.00', { toAccount: tradingAccountId });
    const ask = () =>
      transfers.request({
        userId,
        tradingAccountId,
        direction: 'wallet_to_account',
        amount: '50.00',
        currency: 'USD',
        provenance: { origin: 'deposit', sourceTransactionId: depositId },
      });

    // Two chains racing for one deposit, then a third retry.
    const [a, b] = await Promise.all([ask(), ask()]);
    const c = await ask();
    expect(new Set([a.id, b.id, c.id]).size).toBe(1);
    expect(await transferRow(a.id)).toMatchObject({
      origin: 'deposit',
      source_transaction_id: depositId,
      request_ref: `deposit:${depositId}`,
    });
    expect(await onHold(userId)).toBe('50.00000000');
  });

  it('a desk credit names its credit, the desk member and the reason', async () => {
    const userId = await client('p-desk@test.local');
    const tradingAccountId = await account(userId);
    const creditId = await deposit(userId, '25.00', { provider: 'manual_admin', ref: 'key-1' });
    const row = await transfers.request({
      userId,
      tradingAccountId,
      direction: 'wallet_to_account',
      amount: '25.00',
      currency: 'USD',
      requestRef: 'admin-fund:key-1',
      provenance: {
        origin: 'desk_credit',
        sourceTransactionId: creditId,
        adminId: ADMIN,
        reason: 'Welcome bonus',
      },
    });
    expect(await transferRow(row.id)).toMatchObject({
      origin: 'desk_credit',
      source_transaction_id: creditId,
      requested_by_admin_id: ADMIN,
      desk_reason: 'Welcome bonus',
    });
  });

  it('refuses an origin that does not fit the direction, before anything is held', async () => {
    const userId = await client('p-dir@test.local');
    const tradingAccountId = await account(userId);
    await expect(
      transfers.request({
        userId,
        tradingAccountId,
        direction: 'wallet_to_account',
        amount: '5.00',
        currency: 'USD',
        provenance: { origin: 'desk_debit', adminId: ADMIN, reason: 'x' },
      }),
    ).rejects.toBeInstanceOf(ValidationError);
    expect(await onHold(userId)).toBe('0.00000000');
  });

  it('refuses a replayed key that claims a different origin', async () => {
    const userId = await client('p-replay@test.local');
    const tradingAccountId = await account(userId);
    const base = {
      userId,
      tradingAccountId,
      direction: 'wallet_to_account' as const,
      amount: '5.00',
      currency: 'USD',
      requestRef: 'admin-move:key-2',
    };
    await transfers.request({
      ...base,
      provenance: { origin: 'desk_wallet', adminId: ADMIN, reason: 'move' },
    });
    await expect(
      transfers.request({ ...base, provenance: { origin: 'client' } }),
    ).rejects.toBeInstanceOf(ConflictError);
  });
});

describe('the database holds the same rules', () => {
  async function insertTransfer(fields: string, values: string, params: unknown[]) {
    return q<{ id: string }>(
      `INSERT INTO transfers (user_id, wallet_id, trading_account_id, direction, amount, currency${fields})
       SELECT $1, w.id, $2, $3::transfer_direction, $4, 'USD'${values}
         FROM wallets w WHERE w.user_id = $1 RETURNING id`,
      params,
    );
  }

  it('refuses a source that is another client’s deposit, or a different amount', async () => {
    const owner = await client('p-src-a@test.local');
    const stranger = await client('p-src-b@test.local');
    const ownerAccount = await account(owner);
    const strangersDeposit = await deposit(stranger, '30.00', { toAccount: ownerAccount });
    await expect(
      insertTransfer(', origin, source_transaction_id', `, 'deposit', $5`, [
        owner,
        ownerAccount,
        'wallet_to_account',
        '30.00',
        strangersDeposit,
      ]),
    ).rejects.toThrow(/not this client's settled deposit/);

    const ownDeposit = await deposit(owner, '30.00', { toAccount: ownerAccount });
    await expect(
      insertTransfer(', origin, source_transaction_id', `, 'deposit', $5`, [
        owner,
        ownerAccount,
        'wallet_to_account',
        '29.99',
        ownDeposit,
      ]),
    ).rejects.toThrow(/not this client's settled deposit/);
  });

  it('refuses a deposit origin with no source, commission on this table, and a desk member on a client transfer', async () => {
    const userId = await client('p-ck@test.local');
    const tradingAccountId = await account(userId);
    const params = [userId, tradingAccountId, 'wallet_to_account', '1.00'];
    await expect(insertTransfer(', origin', `, 'deposit'`, params)).rejects.toThrow(
      /transfers_origin_source_ck/,
    );
    await expect(insertTransfer(', origin', `, 'commission'`, params)).rejects.toThrow(
      /transfers_origin_ck/,
    );
    await expect(
      insertTransfer(', origin, requested_by_admin_id', `, 'client', '${ADMIN}'`, params),
    ).rejects.toThrow(/transfers_origin_admin_ck/);
  });

  it('works out the origin for a writer that states none, from the ref it writes', async () => {
    const userId = await client('p-old@test.local');
    const tradingAccountId = await account(userId);
    const creditId = await deposit(userId, '7.00', { provider: 'manual_admin', ref: 'old-key' });
    const [fund] = await insertTransfer(', request_ref', `, 'admin-fund:old-key'`, [
      userId,
      tradingAccountId,
      'wallet_to_account',
      '7.00',
    ]);
    expect(await transferRow(fund.id)).toMatchObject({
      origin: 'desk_credit',
      source_transaction_id: creditId,
    });
    const [move] = await insertTransfer(', request_ref', `, 'admin-move:other'`, [
      userId,
      tradingAccountId,
      'wallet_to_account',
      '1.00',
    ]);
    expect((await transferRow(move.id)).origin).toBe('desk_wallet');
    const [plain] = await insertTransfer('', '', [
      userId,
      tradingAccountId,
      'account_to_wallet',
      '1.00',
    ]);
    expect((await transferRow(plain.id)).origin).toBe('client');
  });

  it('freezes provenance while the lifecycle still moves, and keeps the funding deposit', async () => {
    const userId = await client('p-frozen@test.local');
    const tradingAccountId = await account(userId);
    const depositId = await deposit(userId, '12.00', { toAccount: tradingAccountId });
    const row = await transfers.request({
      userId,
      tradingAccountId,
      direction: 'wallet_to_account',
      amount: '12.00',
      currency: 'USD',
      provenance: { origin: 'deposit', sourceTransactionId: depositId },
    });
    await expect(
      q(`UPDATE transfers SET origin = 'client', source_transaction_id = NULL WHERE id = $1`, [
        row.id,
      ]),
    ).rejects.toThrow(/provenance is written once/);
    await q(`UPDATE transfers SET state = 'failed', failure_reason = 'x' WHERE id = $1`, [row.id]);
    await expect(q(`DELETE FROM transactions WHERE id = $1`, [depositId])).rejects.toThrow(
      /foreign key/,
    );
  });

  it('freezes a payment’s approval and desk reason once written', async () => {
    const userId = await client('p-pay@test.local');
    const txId = await deposit(userId, '3.00', { provider: 'manual_admin', ref: 'pay-1' });
    await q(
      `UPDATE transactions SET approved_by_admin_id = $2, approved_at = now(), desk_reason = 'why'
        WHERE id = $1`,
      [txId, ADMIN],
    );
    await expect(
      q(`UPDATE transactions SET approved_by_admin_id = gen_random_uuid() WHERE id = $1`, [txId]),
    ).rejects.toThrow(/written once/);
    await expect(
      q(`UPDATE transactions SET desk_reason = 'other' WHERE id = $1`, [txId]),
    ).rejects.toThrow(/written once/);
    // An approval without its time, or a time without its approver, is refused.
    const other = await deposit(userId, '1.00', { ref: 'pay-2' });
    await expect(
      q(`UPDATE transactions SET approved_by_admin_id = $2 WHERE id = $1`, [other, ADMIN]),
    ).rejects.toThrow(/transactions_approval_pair_ck/);
  });
});

describe('the backfill (0226 / 0227) classifies history exactly', () => {
  const m0226 = readFileSync('src/database/migrations/0226_transfer_provenance.sql', 'utf8');
  const m0227 = readFileSync('src/database/migrations/0227_payment_provenance.sql', 'utf8');

  /** History as the previous build wrote it: every transfer 'client', nothing linked. */
  async function legacyTransfer(
    userId: number,
    tradingAccountId: string,
    amount: string,
    opts: { ref?: string; direction?: string; createdAt?: string } = {},
  ): Promise<string> {
    const [{ id }] = await q<{ id: string }>(
      `INSERT INTO transfers (user_id, wallet_id, trading_account_id, direction, amount, currency,
                              state, request_ref, origin, created_at)
       SELECT $1, w.id, $2, $3::transfer_direction, $4, 'USD', 'settled', $5, 'client',
              COALESCE($6::timestamptz, now())
         FROM wallets w WHERE w.user_id = $1 RETURNING id`,
      [
        userId,
        tradingAccountId,
        opts.direction ?? 'wallet_to_account',
        amount,
        opts.ref ?? null,
        opts.createdAt ?? null,
      ],
    );
    return id;
  }

  async function auditRow(action: string, subjectType: string, subjectId: string, details: object) {
    await q(
      `INSERT INTO audit_log (actor_id, actor_email, action, subject_type, subject_id, details, actor_kind)
       VALUES ($1, 'desk@test.local', $2, $3, $4, $5::jsonb, 'admin')`,
      [ADMIN, action, subjectType, subjectId, JSON.stringify(details)],
    );
  }

  it('desk origins, the credit behind a desk credit, who and why, deposit chains one-to-one — and a second run changes nothing', async () => {
    const userId = await client('p-bf@test.local', '5000');
    const acc = await account(userId);
    const t0 = '2026-10-10T10:00:00Z';

    // A desk credit: its manual credit (same key) and the in-transaction audit row.
    const credit = await deposit(userId, '100.00', { provider: 'manual_admin', ref: 'K1' });
    await auditRow('wallet.credit', 'transaction', credit, { reason: 'Bonus', reasonAr: 'مكافأة' });
    const fund = await legacyTransfer(userId, acc, '100.00', { ref: 'admin-fund:K1' });
    // A desk debit named by its trading.withdraw row.
    const debit = await legacyTransfer(userId, acc, '20.00', {
      ref: 'admin-debit:K2',
      direction: 'account_to_wallet',
    });
    await auditRow('trading.withdraw', 'trading_account', acc, {
      transferId: debit,
      reason: 'Correction',
    });

    // Two deposits of 40 aimed at the account, two transfers of 40: matched closest-first, 1:1.
    const d1 = await deposit(userId, '40.00', { toAccount: acc, settledAt: t0 });
    const d2 = await deposit(userId, '40.00', {
      toAccount: acc,
      settledAt: '2026-10-10T10:05:00Z',
    });
    const c1 = await legacyTransfer(userId, acc, '40.00', { createdAt: '2026-10-10T10:00:03Z' });
    const c2 = await legacyTransfer(userId, acc, '40.00', { createdAt: '2026-10-10T10:05:02Z' });
    // Outside the window: the client's own move, not the deposit's.
    const d3 = await deposit(userId, '15.00', { toAccount: acc, settledAt: t0 });
    const late = await legacyTransfer(userId, acc, '15.00', { createdAt: '2026-10-10T11:00:00Z' });

    // A manual payment with its audit row, and a withdrawal approval.
    await auditRow('withdrawal.approve', 'transaction', d3, {});

    const totalsBefore = await q(`SELECT * FROM movement_total_deltas ORDER BY 1, 2, 3, 4, 5, 6`);
    await ctx.pool.query(m0226);
    await ctx.pool.query(m0227);

    expect(await transferRow(fund)).toMatchObject({
      origin: 'desk_credit',
      source_transaction_id: credit,
      requested_by_admin_id: ADMIN,
      desk_reason: 'Bonus',
    });
    expect(await transferRow(debit)).toMatchObject({
      origin: 'desk_debit',
      requested_by_admin_id: ADMIN,
      desk_reason: 'Correction',
    });
    expect(await transferRow(c1)).toMatchObject({ origin: 'deposit', source_transaction_id: d1 });
    expect(await transferRow(c2)).toMatchObject({ origin: 'deposit', source_transaction_id: d2 });
    expect(await transferRow(late)).toMatchObject({
      origin: 'client',
      source_transaction_id: null,
    });

    const [manual] = await q<{ reviewed_by: string; desk_reason: string; desk_reason_ar: string }>(
      `SELECT reviewed_by, desk_reason, desk_reason_ar FROM transactions WHERE id = $1`,
      [credit],
    );
    expect(manual).toEqual({ reviewed_by: ADMIN, desk_reason: 'Bonus', desk_reason_ar: 'مكافأة' });
    const [approved] = await q<{ approved_by_admin_id: string }>(
      `SELECT approved_by_admin_id FROM transactions WHERE id = $1`,
      [d3],
    );
    expect(approved.approved_by_admin_id).toBe(ADMIN);

    // A second run is a no-op, and no money total moved.
    const snapshot = await q(`SELECT id, origin, source_transaction_id FROM transfers ORDER BY id`);
    await ctx.pool.query(m0226);
    await ctx.pool.query(m0227);
    expect(await q(`SELECT id, origin, source_transaction_id FROM transfers ORDER BY id`)).toEqual(
      snapshot,
    );
    expect(await q(`SELECT * FROM movement_total_deltas ORDER BY 1, 2, 3, 4, 5, 6`)).toEqual(
      totalsBefore,
    );
  });
});

describe('a client’s own history', () => {
  it('no longer carries the id of the admin who decided', async () => {
    const userId = await client('p-leak@test.local');
    const id = await deposit(userId, '9.00', { ref: 'leak-1' });
    await q(`UPDATE transactions SET reviewed_by = $2, reviewed_at = now() WHERE id = $1`, [
      id,
      ADMIN,
    ]);
    const history = await new TransactionQueries(ctx.db, {} as PaymentProviderRegistry).listForUser(
      userId,
    );
    const row = history.items.find((item) => item.id === id);
    expect(row).toBeDefined();
    expect(row).not.toHaveProperty('reviewedBy');
  });
});
