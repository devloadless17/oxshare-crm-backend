import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { ConfigService } from '@nestjs/config';
import { TransactionsService } from '../src/modules/payments/transactions.service';
import { PaymentMethodsService } from '../src/modules/payments/payment-methods.service';
import { WalletService } from '../src/modules/wallet/wallet.service';
import { CurrenciesService } from '../src/modules/currencies/currencies.service';
import { auditStubAs } from './audit-stub';
import { AuditLogStore } from '../src/store/audit-log.store';
import { emailStubAs } from './email-stub';
import { notificationsStub } from './notifications-stub';
import { transferExecutorStubAs, transfersStubAs } from './transfer-chain-stub';
import { gatewayStub } from './gateway-stub';
import { startMoneyTestDb, stopMoneyTestDb, type MoneyTestContext } from './money-setup';
import { HostedDepositsService } from '../src/modules/payments/core/hosted-deposits.service';
import type { ProviderNotice } from '../src/modules/payments/providers/payment-provider';

/**
 * Rival's hosted deposits through the payments CORE (0173), against real
 * Postgres. `HostedDepositsService.onNotice` is what every verified webhook
 * reaches — a doorbell: it asks the provider (the stub below) and applies THAT
 * — and every row of its mapping table is asserted here, including the
 * ones whose whole job is to do NOTHING to a balance: an out-of-order replay,
 * a late completion against a terminally failed row, a reversal. In a money
 * system the refusals are as load-bearing as the credit.
 *
 * The gateway is the STUB, driven per-test: the mapping's contract is "what
 * does Rival's stored state say", and the stub is that state. The full chain
 * with a real HTTP fake behind it is `rival-webhook-http.spec.ts`; the §11
 * idempotency/concurrency of the credit itself is `wallet-service.spec.ts`.
 * This file owns the STATE MACHINE.
 */

let ctx: MoneyTestContext;
/**
 * The admin bell. A deposit only a person can settle is a TASK on the deposit
 * desk (migration 0140) — the pager alert alone reached nobody.
 */
const bell = notificationsStub();
let wallets: WalletService;
let transactions: TransactionsService;
let gateway: ReturnType<typeof gatewayStub>;
let deposits: HostedDepositsService;

/** A verified Rival deposit event, as its receiver turns it into a notice. */
function event(externalId: string, kind: 'completed' | 'failed' | 'reversed'): ProviderNotice {
  return {
    subject: 'payment',
    providerId: externalId,
    providerType: `transaction.${kind}`,
    eventType:
      kind === 'completed'
        ? 'payment.succeeded'
        : kind === 'failed'
          ? 'payment.failed'
          : 'payment.reversed',
    kind: kind === 'reversed' ? 'alarm' : 'status',
  };
}
const applyEvent = (externalId: string, kind: 'completed' | 'failed' | 'reversed') =>
  deposits.onNotice('rival', event(externalId, kind));

beforeAll(async () => {
  ctx = await startMoneyTestDb();
  wallets = new WalletService(ctx.db);
  const currencies = new CurrenciesService(ctx.db, auditStubAs());
  gateway = gatewayStub();
  const paymentMethods = new PaymentMethodsService(ctx.db, currencies, auditStubAs(), gateway);
  transactions = new TransactionsService(
    wallets,
    ctx.db,
    paymentMethods,
    currencies,
    gateway,
    new ConfigService(),
    emailStubAs(),
    bell,
    transfersStubAs(),
    transferExecutorStubAs(),
  );
  deposits = new HostedDepositsService(
    ctx.db,
    gateway,
    wallets,
    transactions,
    paymentMethods,
    currencies,
    new AuditLogStore(ctx.db),
    bell,
  );
}, 120_000);

afterAll(async () => {
  await stopMoneyTestDb(ctx);
});

let seq = 0;

/** A pending whish deposit with a Rival externalId, plus its owner's wallet. */
async function makePendingDeposit(amount = '150'): Promise<{
  txId: string;
  userId: number;
  externalId: string;
  reference: string;
}> {
  seq += 1;
  const externalId = String(500_000 + seq);
  const reference = `OX-RDF${String(seq).padStart(4, '0')}`;
  const { rows: userRows } = await ctx.db.execute<{ id: number }>(sql`
    INSERT INTO users (email, password_hash, first_name, last_name, email_verified)
    VALUES (${`rival-flow-${seq}@spec.test`}, 'x', 'Flow', 'Client', true)
    RETURNING id
  `);
  const userId = userRows[0].id;
  const { rows: walletRows } = await ctx.db.execute<{ id: string }>(sql`
    INSERT INTO wallets (user_id, currency) VALUES (${userId}, 'USD') RETURNING id
  `);
  const { rows: txRows } = await ctx.db.execute<{ id: string }>(sql`
    INSERT INTO transactions
      (user_id, wallet_id, direction, amount, currency, state, method_key, provider,
       provider_ref, provider_payment_id)
    VALUES
      (${userId}, ${walletRows[0].id}, 'deposit', ${amount}, 'USD', 'pending', 'whish',
       'whish', ${reference}, ${externalId})
    RETURNING id
  `);
  return { txId: txRows[0].id, userId, externalId, reference };
}

async function stateOf(txId: string): Promise<{
  state: string;
  needsAttention: boolean;
  // The REASON as well as the flag: a flag with no words sends the operator to
  // the logs, so the message is part of the contract and worth asserting.
  attentionReason: string | null;
}> {
  const { rows } = await ctx.db.execute<{
    state: string;
    needs_attention: boolean;
    attention_reason: string | null;
  }>(
    sql`SELECT state, needs_attention, attention_reason
          FROM transactions WHERE id = ${txId}`,
  );
  return {
    state: rows[0].state,
    needsAttention: rows[0].needs_attention,
    attentionReason: rows[0].attention_reason,
  };
}

async function balanceOf(userId: number): Promise<string> {
  const { rows } = await ctx.db.execute<{ balance: string }>(
    sql`SELECT balance FROM wallets WHERE user_id = ${userId}`,
  );
  return rows[0].balance;
}

function rivalSays(
  status: 'PENDING' | 'PAID' | 'FAILED',
  /**
   * What the PLATFORM says the payment is for. Omitted by every other caller on
   * purpose — an absent amount means "this gateway offers no second opinion",
   * which is the shape the cross-check must treat as nothing to compare.
   */
  claims?: { amount: string; currency?: string },
) {
  gateway.checkPayment.mockResolvedValue({
    settled: status !== 'PENDING',
    paid: status === 'PAID',
    rawStatus: status,
    needsAttention: false,
    ...(claims ? { amount: claims.amount, currency: claims.currency ?? 'USD' } : {}),
  });
}

beforeEach(async () => {
  await ctx.db.execute(sql`
    INSERT INTO currencies (code, name, symbol, enabled, is_default)
    VALUES ('USD', 'US Dollar', '$', true, true)
    ON CONFLICT (code) DO NOTHING
  `);
  await ctx.db.execute(sql`
    INSERT INTO payment_methods (key, name, currency, enabled)
    VALUES ('whish', 'Whish', 'USD', true)
    ON CONFLICT (key) DO NOTHING
  `);
});

describe('the mapping table, row by row', () => {
  it('completed on a pending row credits the gross amount exactly once', async () => {
    const { txId, userId, externalId } = await makePendingDeposit('150');
    rivalSays('PAID');

    expect(await applyEvent(externalId, 'completed')).toBe('applied');
    expect((await stateOf(txId)).state).toBe('success');
    expect(await balanceOf(userId)).toBe('150.00000000');

    // At-least-once delivery: the duplicate is absorbed, the balance holds.
    expect(await applyEvent(externalId, 'completed')).toBe('duplicate');
    expect(await balanceOf(userId)).toBe('150.00000000');
    const { rows } = await ctx.db.execute<{ n: string }>(
      sql`SELECT count(*) AS n FROM ledger_entries le
          JOIN wallets w ON w.id = le.wallet_id WHERE w.user_id = ${userId}`,
    );
    expect(rows[0].n).toBe('1');
  });

  /*
   * THE TRAIL, FOR MONEY NOBODY APPROVED.
   *
   * Every other way a wallet is credited leaves a row somebody can search:
   * `deposit.approve` for an offline deposit, `wallet.credit` for a hand
   * adjustment. The gateway path wrote none, and on the production database
   * that was eight settled deposits totalling 3,190.12 present in the ledger
   * and absent from the trail. Nothing failed, which is why it survived.
   *
   * `details.userId` is asserted for a reason beyond completeness: the audit
   * scope predicate resolves a `transaction` row's client from exactly that
   * key, and a row it cannot resolve is KEPT for every reader. Without it this
   * fix would close a blind spot by opening a leak.
   */
  it('a gateway settlement writes a system audit row naming the client', async () => {
    const { txId, userId, externalId } = await makePendingDeposit('150');
    rivalSays('PAID');
    expect(await applyEvent(externalId, 'completed')).toBe('applied');

    const { rows } = await ctx.db.execute<{
      action: string;
      actor_kind: string;
      actor_email: string;
      user_id: string | null;
      n: string;
    }>(
      sql`SELECT action, actor_kind, actor_email,
                 details->>'userId' AS user_id, count(*) OVER () AS n
            FROM audit_log
           WHERE subject_type = 'transaction' AND subject_id = ${txId}
             AND action = 'deposit.settle'`,
    );

    expect(rows).toHaveLength(1);
    expect(rows[0].actor_kind).toBe('system');
    expect(rows[0].actor_email).toBe('system@oxshare.internal');
    expect(rows[0].user_id).toBe(String(userId)); // `->>` reads the jsonb number as text

    /*
     * At-least-once delivery must not double the trail either. The replay is
     * absorbed before the conditional UPDATE, so the second call writes nothing.
     */
    expect(await applyEvent(externalId, 'completed')).toBe('duplicate');
    const after = await ctx.db.execute<{ n: string }>(
      sql`SELECT count(*) AS n FROM audit_log
           WHERE subject_id = ${txId} AND action = 'deposit.settle'`,
    );
    expect(after.rows[0].n).toBe('1');
  });

  it('REFUSES to credit when the platform names a different amount', async () => {
    /*
     * The deposit was created for 150; the platform says 40 was paid.
     *
     * Crediting `tx.amount` regardless is how a system pays out money nobody
     * paid in — and it leaves a ledger that is perfectly self-consistent
     * afterwards, so nothing surfaces until somebody reconciles against the
     * provider's dashboard months later.
     *
     * It REFUSES rather than picking a figure. Crediting the smaller invents a
     * business rule nobody agreed to; crediting the larger gives money away.
     * `pending` is the only state that keeps both options open for a human.
     */
    const { txId, userId, externalId } = await makePendingDeposit('150');
    rivalSays('PAID', { amount: '40.00' });

    // A person's now — answered 'needs-attention' (Rival stops retrying a
    // delivery no retry can resolve), not 'pending'.
    expect(await applyEvent(externalId, 'completed')).toBe('needs-attention');

    const row = await stateOf(txId);
    expect(row.state, 'a disputed deposit must stay settleable by hand').toBe('pending');
    expect(await balanceOf(userId), 'nothing may be credited').toBe('0.00000000');
    expect(row.needsAttention).toBe(true);
    expect(String(row.attentionReason)).toMatch(/40/);
    expect(String(row.attentionReason)).toMatch(/150/);
    expect(bell.notifyAdmins).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'admin.deposit.attention',
        subject: { id: txId, clientId: userId },
        // A CODE — the provider's wording never reaches a bell.
        params: expect.objectContaining({ reason: 'amount_mismatch' }) as unknown,
      }),
    );
  });

  it('credits normally when the platform AGREES, including on trailing zeros', async () => {
    // '150.00' vs '150.00000000' is the same money. Comparing the STRINGS would
    // flag every healthy deposit — which is how a good guard gets switched off.
    const { txId, userId, externalId } = await makePendingDeposit('150');
    rivalSays('PAID', { amount: '150.00' });

    expect(await applyEvent(externalId, 'completed')).toBe('applied');
    expect((await stateOf(txId)).state).toBe('success');
    expect(await balanceOf(userId)).toBe('150.00000000');
  });

  it('failed on a pending row is terminal and credits nothing', async () => {
    const { txId, userId, externalId } = await makePendingDeposit();
    rivalSays('FAILED');

    expect(await applyEvent(externalId, 'failed')).toBe('applied');
    expect((await stateOf(txId)).state).toBe('failure');
    expect(await balanceOf(userId)).toBe('0.00000000');
  });

  it('out-of-order events cannot regress a settled row: completed → failed → completed', async () => {
    const { txId, userId, externalId } = await makePendingDeposit('80');
    rivalSays('PAID');
    await applyEvent(externalId, 'completed');

    expect(await applyEvent(externalId, 'failed')).toBe('stale');
    expect((await stateOf(txId)).state).toBe('success');
    expect(await applyEvent(externalId, 'completed')).toBe('duplicate');
    expect(await balanceOf(userId)).toBe('80.00000000');
  });

  it('completed against a terminally FAILED row flags a human and never resurrects', async () => {
    const { txId, userId, externalId } = await makePendingDeposit();
    rivalSays('FAILED');
    await applyEvent(externalId, 'failed');

    // Rival now says the money arrived — after our row died. Money exists at
    // Rival, no wallet was credited, and no code path may decide which side
    // is right. (The doorbell rule: it is Rival's STORED state that says so.)
    rivalSays('PAID');
    expect(await applyEvent(externalId, 'completed')).toBe('needs-attention');
    const after = await stateOf(txId);
    expect(after.state).toBe('failure');
    expect(after.needsAttention).toBe(true);
    expect(await balanceOf(userId)).toBe('0.00000000');
    expect(bell.notifyAdmins).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'admin.deposit.attention',
        subject: { id: txId, clientId: userId },
        params: expect.objectContaining({ reason: 'paid_after_failure' }) as unknown,
      }),
    );
  });

  it('reversed NEVER touches the ledger — flag, alert, human decision (§6.4)', async () => {
    const { txId, userId, externalId } = await makePendingDeposit('60');
    rivalSays('PAID');
    await applyEvent(externalId, 'completed');
    expect(await balanceOf(userId)).toBe('60.00000000');

    expect(await applyEvent(externalId, 'reversed')).toBe('needs-attention');
    const after = await stateOf(txId);
    expect(after.state).toBe('success');
    expect(after.needsAttention).toBe(true);
    // The credit stands until a human writes the compensating entry.
    expect(await balanceOf(userId)).toBe('60.00000000');
    expect(bell.notifyAdmins).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'admin.deposit.attention',
        subject: { id: txId, clientId: userId },
        params: expect.objectContaining({ reason: 'reversed' }) as unknown,
      }),
    );
  });

  it('an event for an unknown externalId reports the race, changing nothing', async () => {
    expect(await applyEvent('424242424', 'completed')).toBe('unknown-reference');
  });

  it('an event whose settle still reads PENDING at Rival stays retryable', async () => {
    const { txId, externalId } = await makePendingDeposit();
    rivalSays('PENDING');

    expect(await applyEvent(externalId, 'completed')).toBe('pending');
    expect((await stateOf(txId)).state).toBe('pending');
  });
});

describe('the webhook races the portal status poll', () => {
  it('two concurrent settles produce one credit', async () => {
    const { userId, externalId, reference } = await makePendingDeposit('90');
    rivalSays('PAID');

    const [a, b] = await Promise.all([
      applyEvent(externalId, 'completed'),
      deposits.settle('whish', reference),
    ]);
    // Whichever won, exactly one credit exists and both callers saw a settled row.
    expect([a, String(b.state)]).toBeTruthy();
    expect(await balanceOf(userId)).toBe('90.00000000');
    const { rows } = await ctx.db.execute<{ n: string }>(
      sql`SELECT count(*) AS n FROM ledger_entries le
          JOIN wallets w ON w.id = le.wallet_id WHERE w.user_id = ${userId}`,
    );
    expect(rows[0].n).toBe('1');
  });
});

describe('the poller repairs an unconfirmed create', () => {
  it('a lost start is recovered under the same idempotency key', async () => {
    const { txId, reference, externalId } = await makePendingDeposit();
    // Simulate the indeterminate create: the id was never stored.
    await ctx.db.execute(
      sql`UPDATE transactions SET provider_payment_id = NULL WHERE id = ${txId}`,
    );
    gateway.recoverPayment.mockResolvedValueOnce({
      paymentUrl: 'https://pay.example.test/x',
      externalId,
    });

    expect(await deposits.recoverStart(txId)).toBe(true);
    const call = gateway.recoverPayment.mock.calls.at(-1);
    expect(call?.[1]).toMatchObject({ idempotencyKey: reference });
    const { rows } = await ctx.db.execute<{ provider_payment_id: string }>(
      sql`SELECT provider_payment_id FROM transactions WHERE id = ${txId}`,
    );
    expect(rows[0].provider_payment_id).toBe(externalId);
  });

  it('redirects point at the API return bounce when API_PUBLIC_URL is public, else are omitted', async () => {
    const { txId, reference, externalId } = await makePendingDeposit();
    await ctx.db.execute(
      sql`UPDATE transactions SET provider_payment_id = NULL WHERE id = ${txId}`,
    );

    // No public API address (and no reachable portal): the pair is OMITTED —
    // sending a localhost URL would fail the create at Rival (D-68).
    gateway.recoverPayment.mockResolvedValueOnce({
      paymentUrl: 'https://pay.example.test/x',
      externalId,
    });
    expect(await deposits.recoverStart(txId)).toBe(true);
    let input = gateway.recoverPayment.mock.calls.at(-1)?.[1] as Record<string, unknown>;
    expect(input.successRedirectUrl).toBeUndefined();
    expect(input.failureRedirectUrl).toBeUndefined();

    // With a public API address the provider gets the RETURN BOUNCE — the
    // portal's own (possibly localhost) address never reaches the provider.
    process.env.API_PUBLIC_URL = 'https://api.oxshare.example';
    try {
      await ctx.db.execute(
        sql`UPDATE transactions SET provider_payment_id = NULL WHERE id = ${txId}`,
      );
      gateway.recoverPayment.mockResolvedValueOnce({
        paymentUrl: 'https://pay.example.test/x',
        externalId,
      });
      expect(await deposits.recoverStart(txId)).toBe(true);
      input = gateway.recoverPayment.mock.calls.at(-1)?.[1] as Record<string, unknown>;
      expect(input.successRedirectUrl).toBe(
        `https://api.oxshare.example/v1/payments/deposits/${reference}/return/success?method=whish`,
      );
      expect(input.failureRedirectUrl).toBe(
        `https://api.oxshare.example/v1/payments/deposits/${reference}/return/failure?method=whish`,
      );
    } finally {
      delete process.env.API_PUBLIC_URL;
    }
  });

  it('refuses to touch a row that is settled, addressed, or not a gateway deposit', async () => {
    const { txId, externalId } = await makePendingDeposit();
    // Already addressed: nothing to recover.
    expect(await deposits.recoverStart(txId)).toBe(false);

    rivalSays('PAID');
    await applyEvent(externalId, 'completed');
    await ctx.db.execute(
      sql`UPDATE transactions SET provider_payment_id = NULL WHERE id = ${txId}`,
    );
    // Settled: replaying a create for it would mint a payable link for money
    // that already arrived.
    expect(await deposits.recoverStart(txId)).toBe(false);
  });
});
