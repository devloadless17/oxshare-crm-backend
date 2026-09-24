import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { ConfigService } from '@nestjs/config';
import { TransactionsService } from '../src/modules/payments/transactions.service';
import { WalletService } from '../src/modules/wallet/wallet.service';
import { CurrenciesService } from '../src/modules/currencies/currencies.service';
import { MoneyLimits } from '../src/config/money-limits';
import { PaymentMethodsService } from '../src/modules/payments/payment-methods.service';
import { SYSTEM_ACTOR } from '../src/common/security/actor';
import { auditStubAs } from './audit-stub';
import { AuditLogStore } from '../src/store/audit-log.store';
import { emailStubAs } from './email-stub';
import { notificationsStubAs } from './notifications-stub';
import { transferExecutorStubAs, transfersStubAs } from './transfer-chain-stub';
import { gatewayStubAs } from './gateway-stub';
import { startMoneyTestDb, stopMoneyTestDb, type MoneyTestContext } from './money-setup';

/**
 * OFFLINE DEPOSITS — the client paid outside the platform, uploaded a receipt,
 * and an operator decides.
 *
 * The whole point of this file is that APPROVAL MINTS BALANCE. A withdrawal can
 * only ever pay out money the client already had; a deposit approval creates the
 * credit, on the strength of a person's judgement about an image. So the cases
 * that matter are the ones where it happens TWICE, or where it happens after
 * somebody already decided otherwise.
 *
 * Each case names the mutation it kills, because an assertion nobody can break
 * on purpose is not protecting anything.
 */
let ctx: MoneyTestContext;
let transactions: TransactionsService;
let wallets: WalletService;
let methods: PaymentMethodsService;

const ADMIN = '00000000-0000-4000-8000-000000000001';
const OTHER_ADMIN = '00000000-0000-4000-8000-000000000002';
const OFFLINE = 'offline_receipt';
const PLAIN = 'plain_manual';
const RECEIPT = '11111111-1111-4111-8111-111111111111.jpg';

beforeAll(async () => {
  ctx = await startMoneyTestDb();
  wallets = new WalletService(ctx.db);
  const currencies = new CurrenciesService(ctx.db, auditStubAs());
  methods = new PaymentMethodsService(
    ctx.db,
    currencies,
    auditStubAs(),
    gatewayStubAs(),
    new MoneyLimits(new ConfigService()),
  );
  transactions = new TransactionsService(
    wallets,
    ctx.db,
    new MoneyLimits(new ConfigService()),
    methods,
    currencies,
    gatewayStubAs(),
    new ConfigService(),
    emailStubAs(),
    notificationsStubAs(),
    transfersStubAs(),
    transferExecutorStubAs(),
    new AuditLogStore(ctx.db),
  );
  await seedMethods();
}, 120_000);

afterAll(async () => {
  await stopMoneyTestDb(ctx);
});

/*
 * Created once, not per case: `transactions.method_key` is a real foreign key, so
 * a method a deposit referenced cannot be deleted between tests.
 */
async function seedMethods(): Promise<void> {
  await methods.create(
    { key: OFFLINE, name: 'Offline receipt', currency: 'USD', requiresProof: true },
    { ...SYSTEM_ACTOR, id: ADMIN },
  );
  await methods.create(
    { key: PLAIN, name: 'Plain manual', currency: 'USD' },
    { ...SYSTEM_ACTOR, id: ADMIN },
  );
}

/** A verified client with NO wallet yet — a deposit is what opens it. */
async function makeClient(email: string): Promise<string> {
  const { rows } = await ctx.db.execute<{ id: string }>(sql`
    INSERT INTO users (email, password_hash, first_name, last_name, verification_level, email_verified)
    VALUES (${email}, 'x', 'Test', 'Client', 1, true)
    RETURNING id
  `);
  return rows[0].id;
}

/*
 * Declaring a deposit OPENS the wallet, so an untouched client reads
 * '0.00000000' rather than having no row — which is the honest distinction the
 * portal's own em-dash-not-zero rule is about, from the other side.
 */
async function balanceOf(userId: string): Promise<string> {
  const { rows } = await ctx.db.execute<{ balance: string }>(
    sql`SELECT balance FROM wallets WHERE user_id = ${userId} AND currency = 'USD'`,
  );
  return rows[0]?.balance ?? 'no wallet';
}

/** Ledger rows for THIS deposit — the count that must never reach two. */
async function creditsFor(txId: string): Promise<number> {
  const { rows } = await ctx.db.execute<{ count: number }>(sql`
    SELECT count(*)::int AS count FROM ledger_entries
     WHERE reference_type = 'transaction' AND reference_id = ${txId}
  `);
  return rows[0].count;
}

async function stateOf(txId: string) {
  const { rows } = await ctx.db.execute<{
    state: string;
    settled_at: string | null;
    reviewed_by: string | null;
    rejection_reason: string | null;
  }>(sql`
    SELECT state, settled_at, reviewed_by, rejection_reason FROM transactions WHERE id = ${txId}
  `);
  return rows[0];
}

function declare(userId: string, amount = '250') {
  return transactions.requestDeposit({
    userId,
    amount,
    currency: 'USD',
    method: OFFLINE,
    proofFilename: RECEIPT,
  });
}

describe('filing an offline deposit', () => {
  it('records the receipt and credits NOTHING until somebody approves', async () => {
    const userId = await makeClient('offline-file@test.local');
    const deposit = await declare(userId);

    expect((await stateOf(deposit.id)).state).toBe('pending');
    // The declaration is a claim, not money. Kills any future "credit on file".
    expect(await creditsFor(deposit.id)).toBe(0);
    expect(await balanceOf(userId)).toBe('0.00000000');
  });

  it('REFUSES a method that needs a receipt when none is attached', async () => {
    const userId = await makeClient('offline-noproof@test.local');
    // Kills the JSON deposit route becoming a back door into the desk's queue:
    // a proofless declaration is one an operator can only ever reject.
    await expect(
      transactions.requestDeposit({ userId, amount: '250', currency: 'USD', method: OFFLINE }),
    ).rejects.toThrow(/receipt/i);
  });

  it('REFUSES a receipt on a method that did not ask for one', async () => {
    const userId = await makeClient('offline-unwanted@test.local');
    await expect(
      transactions.requestDeposit({
        userId,
        amount: '250',
        currency: 'USD',
        method: PLAIN,
        proofFilename: RECEIPT,
      }),
    ).rejects.toThrow(/does not take a receipt/i);
  });
});

describe('approving an offline deposit', () => {
  it('credits the wallet exactly once, and a second approval refuses', async () => {
    const userId = await makeClient('offline-approve@test.local');
    const deposit = await declare(userId, '250');

    await transactions.approveDeposit(deposit.id, ADMIN);

    expect(await balanceOf(userId)).toBe('250.00000000');
    expect(await creditsFor(deposit.id)).toBe(1);
    const after = await stateOf(deposit.id);
    expect(after.state).toBe('success');
    expect(after.settled_at).not.toBeNull();
    expect(after.reviewed_by).toBe(ADMIN);

    // The §8.7 conditional transition: the state, not a flag, is what refuses.
    await expect(transactions.approveDeposit(deposit.id, OTHER_ADMIN)).rejects.toThrow(/success/);
    expect(await balanceOf(userId)).toBe('250.00000000');
    expect(await creditsFor(deposit.id)).toBe(1);
  });

  it('credits once when two approvals race', async () => {
    const userId = await makeClient('offline-race@test.local');
    const deposit = await declare(userId, '400');

    const results = await Promise.allSettled([
      transactions.approveDeposit(deposit.id, ADMIN),
      transactions.approveDeposit(deposit.id, OTHER_ADMIN),
    ]);

    /*
     * Both calls reach the credit; only one transition wins.
     *
     * ⚠️ WHAT THIS DOES NOT PROVE, checked by mutation rather than assumed: it
     * does NOT prove the losing credit is rolled back. Hoisting the credit out
     * of its transaction entirely still passes this case, because
     * `ledger_entries_wallet_reference_uq` on (wallet, 'transaction', id)
     * absorbs the second post and returns the first entry untouched.
     *
     * That is worth stating plainly: the unique index is the layer actually
     * holding the line here, and the transaction is belt-and-braces behind it.
     * A single deposit cannot be made to credit twice through this path at all —
     * which is the property that matters — but do not read this test as cover
     * for moving the credit outside its transaction.
     */
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(await creditsFor(deposit.id)).toBe(1);
    expect(await balanceOf(userId)).toBe('400.00000000');
  });

  it('keeps money a decimal string, to the last place', async () => {
    const userId = await makeClient('offline-precision@test.local');
    const deposit = await declare(userId, '10.01');
    await transactions.approveDeposit(deposit.id, ADMIN);

    const { rows } = await ctx.db.execute<{ amount: string; balance_after: string }>(sql`
      SELECT amount, balance_after FROM ledger_entries WHERE reference_id = ${deposit.id}
    `);
    // Character-identical, not numerically equal: a float round-trip is right to
    // the cent and wrong in the eighth place.
    expect(rows[0].amount).toBe('10.01000000');
    expect(rows[0].balance_after).toBe('10.01000000');
  });

  it('REFUSES to credit a gateway deposit by hand', async () => {
    const userId = await makeClient('offline-gateway@test.local');
    const deposit = await declare(userId, '100');
    // The same row, re-badged as a gateway payment — which is exactly the state
    // the guard has to recognise, since the provider column is what tells the
    // two eras apart.
    await ctx.db.execute(sql`UPDATE transactions SET provider = 'whish' WHERE id = ${deposit.id}`);

    /*
     * A gateway deposit is confirmed by the provider's webhook. Crediting one
     * here would pay a client for a payment nobody confirmed — and the webhook
     * would then settle it again, which the ledger constraint absorbs silently,
     * leaving a credited deposit that traces to no payment.
     */
    await expect(transactions.approveDeposit(deposit.id, ADMIN)).rejects.toThrow(
      /payment provider/i,
    );
    expect(await creditsFor(deposit.id)).toBe(0);
    expect(await balanceOf(userId)).toBe('0.00000000');
  });
});

describe('rejecting an offline deposit', () => {
  it('moves NO money — there is nothing to refund', async () => {
    const userId = await makeClient('offline-reject@test.local');
    const deposit = await declare(userId, '250');

    await transactions.rejectDeposit(deposit.id, ADMIN, 'The receipt is unreadable');

    const after = await stateOf(deposit.id);
    expect(after.state).toBe('rejected');
    expect(after.rejection_reason).toBe('The receipt is unreadable');
    // Nothing settled, so nothing is stamped.
    expect(after.settled_at).toBeNull();

    /*
     * KILLS THE MOST LIKELY WRONG TURN IN THIS FEATURE: copying the withdrawal
     * reject, which posts a compensating credit because a withdrawal debits on
     * request. A deposit debits nothing, so a "refund" here would CREATE money
     * the platform never received.
     */
    expect(await creditsFor(deposit.id)).toBe(0);
    expect(await balanceOf(userId)).toBe('0.00000000');
  });

  it('refuses to reject a deposit that was already approved', async () => {
    const userId = await makeClient('offline-reject-late@test.local');
    const deposit = await declare(userId, '120');
    await transactions.approveDeposit(deposit.id, ADMIN);

    await expect(transactions.rejectDeposit(deposit.id, OTHER_ADMIN, 'too late')).rejects.toThrow(
      /success/,
    );
    // And the client keeps the money that was already credited.
    expect(await balanceOf(userId)).toBe('120.00000000');
  });

  it('refuses to approve a deposit that was already rejected', async () => {
    const userId = await makeClient('offline-approve-late@test.local');
    const deposit = await declare(userId, '120');
    await transactions.rejectDeposit(deposit.id, ADMIN, 'no payment found');

    await expect(transactions.approveDeposit(deposit.id, OTHER_ADMIN)).rejects.toThrow(/rejected/);
    expect(await creditsFor(deposit.id)).toBe(0);
    expect(await balanceOf(userId)).toBe('0.00000000');
  });
});
