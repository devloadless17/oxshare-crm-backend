import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { sql } from 'drizzle-orm';
import { ConfigService } from '@nestjs/config';
import { TransactionsService } from '../src/modules/payments/transactions.service';
import { PaymentMethodsService } from '../src/modules/payments/payment-methods.service';
import { RivalWithdrawalsService } from '../src/modules/payments/rival/rival-withdrawals.service';
import type { RivalClient } from '../src/modules/payments/rival/rival.client';
import type { RivalConfigService } from '../src/modules/payments/rival/rival-config.service';
import type { ResourceChangedPublisher } from '../src/common/realtime/resource-changed';
import { WalletService } from '../src/modules/wallet/wallet.service';
import { CurrenciesService } from '../src/modules/currencies/currencies.service';
import { AuditLogStore } from '../src/store/audit-log.store';
import { UsersStore } from '../src/store/users.store';
import { MoneyLimits } from '../src/config/money-limits';
import { auditStubAs } from './audit-stub';
import { emailStubAs } from './email-stub';
import { notificationsStub, notificationsStubAs } from './notifications-stub';
import { transferExecutorStubAs, transfersStubAs } from './transfer-chain-stub';
import { gatewayStubAs } from './gateway-stub';
import { startMoneyTestDb, stopMoneyTestDb, type MoneyTestContext } from './money-setup';

/**
 * The Rival withdrawal choreography, against real Postgres.
 *
 * The property everything here defends: **Rival's withdrawal create has no
 * idempotency key**, so the CRM's claim column and notes-match reconciler are
 * the ONLY things standing between a retry and a double payout. Every test
 * that says "exactly once" or "held, not retried" is that property.
 *
 * The refund and settle legs are the SAME conditional transitions the manual
 * desk uses — asserted here under replay and disagreement, including the
 * refusals: an event echoing history must change nothing, and terminal states
 * that DISAGREE across the two platforms must flag a human, never guess.
 */

let ctx: MoneyTestContext;
let wallets: WalletService;
let transactions: TransactionsService;
let service: RivalWithdrawalsService;

const rival = {
  createWithdrawal: vi.fn(),
  getWithdrawal: vi.fn(),
  cancelWithdrawal: vi.fn(),
  listPendingWithdrawals: vi.fn().mockResolvedValue([]),
};
const rivalConfig = { isEnabled: vi.fn().mockResolvedValue(true) };
// Untyped, so mock-call assertions do not trip the unbound-method rule.
const notifications = notificationsStub();
/*
 * The system settle and refund announce a desk refresh instead of a bell row
 * (migration 0140: a completed or auto-refunded payout is not a task).
 */
const resourceChanged = { publish: vi.fn().mockResolvedValue(undefined) };

beforeAll(async () => {
  ctx = await startMoneyTestDb();
  wallets = new WalletService(ctx.db);
  const currencies = new CurrenciesService(ctx.db, auditStubAs());
  transactions = new TransactionsService(
    wallets,
    ctx.db,
    new MoneyLimits(new ConfigService()),
    new PaymentMethodsService(
      ctx.db,
      currencies,
      auditStubAs(),
      gatewayStubAs(),
      new MoneyLimits(new ConfigService()),
    ),
    currencies,
    gatewayStubAs(),
    new ConfigService(),
    emailStubAs(),
    notificationsStubAs(),
    transfersStubAs(),
    transferExecutorStubAs(),
    new AuditLogStore(ctx.db),
  );
  service = new RivalWithdrawalsService(
    ctx.db,
    rival as unknown as RivalClient,
    rivalConfig as unknown as RivalConfigService,
    transactions,
    new AuditLogStore(ctx.db),
    new UsersStore(ctx.db),
    emailStubAs(),
    notifications,
    resourceChanged as unknown as ResourceChangedPublisher,
  );
}, 120_000);

afterAll(async () => {
  await stopMoneyTestDb(ctx);
});

beforeEach(async () => {
  vi.clearAllMocks();
  rivalConfig.isEnabled.mockResolvedValue(true);
  rival.listPendingWithdrawals.mockResolvedValue([]);
  await ctx.db.execute(sql`
    INSERT INTO currencies (code, name, symbol, enabled, is_default)
    VALUES ('USD', 'US Dollar', '$', true, true) ON CONFLICT (code) DO NOTHING
  `);
});

let seq = 0;

/** A verified, funded client with an APPROVED whish withdrawal. */
async function makeApprovedWithdrawal(amount = '100'): Promise<{
  txId: string;
  userId: string;
}> {
  seq += 1;
  const { rows } = await ctx.db.execute<{ id: string }>(sql`
    INSERT INTO users (email, password_hash, first_name, last_name, verification_level, email_verified)
    VALUES (${`rival-wd-${seq}@spec.test`}, 'x', 'Payout', 'Client', 1, true)
    RETURNING id
  `);
  const userId = rows[0].id;
  await wallets.post({
    userId,
    currency: 'USD',
    amount: '1000',
    entryType: 'deposit',
    referenceType: 'transaction',
    referenceId: `seed-${userId}`,
  });
  const requested = await transactions.requestWithdrawal({
    userId,
    amount,
    currency: 'USD',
    destination: '+961 3 123 456',
    methodKey: 'whish',
  });
  // The rail WILL pay this one, so it is approved into `approved` and settled by
  // Rival's event — the two-step lifecycle this whole suite exercises.
  await transactions.approve(requested.id, '00000000-0000-4000-8000-000000000001', {
    awaitsProviderPayout: true,
  });
  return { txId: requested.id, userId };
}

async function rowOf(txId: string) {
  const { rows } = await ctx.db.execute<{
    state: string;
    rival_withdrawal_id: string | null;
    rival_submitted_at: Date | null;
    rival_needs_attention: boolean;
    rival_attention_reason: string | null;
    provider_ref: string | null;
  }>(sql`SELECT state, rival_withdrawal_id, rival_submitted_at, rival_needs_attention,
               rival_attention_reason, provider_ref
        FROM transactions WHERE id = ${txId}`);
  return rows[0];
}

async function balanceOf(userId: string): Promise<string> {
  const { rows } = await ctx.db.execute<{ balance: string }>(
    sql`SELECT balance FROM wallets WHERE user_id = ${userId}`,
  );
  return rows[0].balance;
}

const rivalRow = (id: string, overrides: Record<string, unknown> = {}) => ({
  id,
  amount: '100.00',
  currency: 'USD',
  /*
   * net EQUALS amount, which is what every commission rule configured for this
   * company actually produces: the payout fee is ON_TOP, charged to OxShare,
   * so the client receives the full amount they asked for.
   *
   * It used to default to '98.00' — a DEDUCTED fee nobody has configured — so
   * the fixture quietly modelled a short payment as the normal case. The
   * shortfall is now an explicit override in the one test that is about it.
   */
  netAmount: '100.00',
  totalAmount: '100.00',
  status: 'PENDING',
  externalReference: null,
  notes: null,
  adminNotes: null,
  processedAt: null,
  createdAt: new Date().toISOString(),
  ...overrides,
});

describe('submit on approval — the no-idempotency-key defence', () => {
  it('claims, creates once with our note and WISH payout, records the id', async () => {
    const { txId } = await makeApprovedWithdrawal();
    rival.createWithdrawal.mockResolvedValue(rivalRow('rw-1'));

    await service.submitApproved(txId);

    expect(rival.createWithdrawal).toHaveBeenCalledTimes(1);
    const input = rival.createWithdrawal.mock.calls[0][0];
    expect(input.notes).toBe(`crm:${txId}`);
    expect(input.recipientPhone).toBe('+961 3 123 456');
    expect(input.recipientName).toBe('Payout Client');

    const row = await rowOf(txId);
    expect(row.rival_withdrawal_id).toBe('rw-1');
    expect(row.rival_submitted_at).not.toBeNull();
    expect(row.state).toBe('approved');
  });

  it('two concurrent submitters produce ONE create — the claim is atomic', async () => {
    const { txId } = await makeApprovedWithdrawal();
    rival.createWithdrawal.mockResolvedValue(rivalRow('rw-2'));

    await Promise.all([service.submitApproved(txId), service.submitApproved(txId)]);
    expect(rival.createWithdrawal).toHaveBeenCalledTimes(1);
  });

  it('FLAGS a payout that will pay the client less than we debited', async () => {
    /*
     * The client is debited in full at REQUEST time. If the platform's fee rule
     * is DEDUCTED rather than ON_TOP, it sends less than that — and nothing in
     * this system recorded the difference, even though `netAmount` was on the
     * create response all along.
     *
     * Flagged rather than refused: the payout genuinely exists at Rival by this
     * point, the create has no idempotency key, and unwinding to retry is the
     * double payment this whole file is arranged to prevent. What is owed is
     * that a human sees it before the client does.
     */
    const { txId } = await makeApprovedWithdrawal();
    rival.createWithdrawal.mockResolvedValue(rivalRow('rw-short', { netAmount: '98.00' }));

    await service.submitApproved(txId);

    const row = await rowOf(txId);
    expect(row.rival_withdrawal_id, 'the payout still exists and is recorded').toBe('rw-short');
    expect(row.rival_needs_attention).toBe(true);
    expect(String(row.rival_attention_reason)).toMatch(/98/);
    expect(String(row.rival_attention_reason)).toMatch(/2 USD short/);
  });

  it('a definite refusal clears the claim, flags the row, tells the approvers', async () => {
    const { txId } = await makeApprovedWithdrawal();
    rival.createWithdrawal.mockRejectedValue(new Error('INSUFFICIENT_BALANCE at Rival'));

    await service.submitApproved(txId);

    const row = await rowOf(txId);
    expect(row.rival_submitted_at).toBeNull(); // one retry is possible
    expect(row.rival_needs_attention).toBe(true);
    // The operator can read WHY, in the platform's own words, on the row.
    expect(row.rival_attention_reason).toContain('INSUFFICIENT_BALANCE at Rival');
    expect(row.state).toBe('approved'); // the approval itself stands
    expect(notifications.notifyAdmins).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'withdrawal.rival_submit_failed',
        subject: expect.objectContaining({ id: txId }) as unknown,
      }),
    );
  });

  it('an INDETERMINATE create holds the claim — a blind retry is a double payout', async () => {
    const { txId } = await makeApprovedWithdrawal();
    const { PaymentIndeterminateError } = await import('../src/common/errors/domain-errors');
    rival.createWithdrawal.mockRejectedValue(new PaymentIndeterminateError('no answer'));

    await service.submitApproved(txId);
    const row = await rowOf(txId);
    expect(row.rival_submitted_at).not.toBeNull(); // HELD
    expect(row.rival_needs_attention).toBe(true);

    // A second submit — the desk's retry button, a cron double-fire — no-ops.
    rival.createWithdrawal.mockResolvedValue(rivalRow('rw-x'));
    await service.submitApproved(txId);
    expect(rival.createWithdrawal).toHaveBeenCalledTimes(1);
  });
});

describe('the reconciler resolves what a timeout left behind', () => {
  it('ADOPTS a created-but-unrecorded withdrawal by notes-match', async () => {
    const { txId } = await makeApprovedWithdrawal();
    const { PaymentIndeterminateError } = await import('../src/common/errors/domain-errors');
    rival.createWithdrawal.mockRejectedValue(new PaymentIndeterminateError('no answer'));
    await service.submitApproved(txId);

    // The create DID land at Rival; only the answer was lost.
    rival.listPendingWithdrawals.mockResolvedValue([
      rivalRow('rw-orphan', { notes: `crm:${txId}` }),
    ]);
    await service.reconcile();

    const row = await rowOf(txId);
    expect(row.rival_withdrawal_id).toBe('rw-orphan');
    expect(row.rival_needs_attention).toBe(false); // resolved
  });

  it('CLEARS a claim the pending list provably lacks, once the window has passed', async () => {
    const { txId } = await makeApprovedWithdrawal();
    const { PaymentIndeterminateError } = await import('../src/common/errors/domain-errors');
    rival.createWithdrawal.mockRejectedValue(new PaymentIndeterminateError('no answer'));
    await service.submitApproved(txId);

    // Fresh claim + empty list: INSIDE the window nothing changes (the create
    // could still be in flight at Rival).
    await service.reconcile();
    expect((await rowOf(txId)).rival_submitted_at).not.toBeNull();

    // Age the claim past the adopt window; now absence is evidence.
    await ctx.db.execute(
      sql`UPDATE transactions SET rival_submitted_at = now() - interval '20 minutes'
          WHERE id = ${txId}`,
    );
    await service.reconcile();
    const row = await rowOf(txId);
    expect(row.rival_submitted_at).toBeNull();
    expect(row.rival_needs_attention).toBe(true);
  });

  it('holds every claim when the pending list itself is unavailable', async () => {
    const { txId } = await makeApprovedWithdrawal();
    const { PaymentIndeterminateError } = await import('../src/common/errors/domain-errors');
    rival.createWithdrawal.mockRejectedValue(new PaymentIndeterminateError('no answer'));
    await service.submitApproved(txId);
    await ctx.db.execute(
      sql`UPDATE transactions SET rival_submitted_at = now() - interval '20 minutes'
          WHERE id = ${txId}`,
    );

    rival.listPendingWithdrawals.mockRejectedValue(new Error('rival down'));
    await service.reconcile();
    // Cannot judge absence without the list: the claim survives.
    expect((await rowOf(txId)).rival_submitted_at).not.toBeNull();
  });
});

describe('inbound events — settle, refund, and the refusals', () => {
  async function submitted(txId: string, rivalId: string): Promise<void> {
    rival.createWithdrawal.mockResolvedValue(rivalRow(rivalId));
    await service.submitApproved(txId);
  }

  it('completed settles with the external reference; the balance does not move again', async () => {
    const { txId, userId } = await makeApprovedWithdrawal('100');
    await submitted(txId, 'rw-10');
    const debited = await balanceOf(userId); // debit-on-request already happened

    const outcome = await service.applyEvent('rw-10', 'completed', {
      externalReference: 'whish-tx-991',
    });
    expect(outcome).toBe('applied');

    const row = await rowOf(txId);
    expect(row.state).toBe('success');
    expect(row.provider_ref).toBe('whish-tx-991');
    expect(await balanceOf(userId)).toBe(debited);

    // At-least-once: the echo is a no-op.
    expect(await service.applyEvent('rw-10', 'completed', {})).toBe('duplicate');
  });

  it('rejected refunds EXACTLY once, with Rival’s reason, under replay', async () => {
    const { txId, userId } = await makeApprovedWithdrawal('100');
    await submitted(txId, 'rw-11');
    const beforeRefund = await balanceOf(userId);

    const outcome = await service.applyEvent('rw-11', 'rejected', {
      adminNotes: 'Recipient number is not registered with Whish',
    });
    expect(outcome).toBe('applied');

    const row = await rowOf(txId);
    expect(row.state).toBe('failure');
    // The hold released and the debit compensated: the client is whole again.
    const afterRefund = await balanceOf(userId);
    expect(Number.parseFloat(afterRefund) > Number.parseFloat(beforeRefund)).toBe(true);

    expect(await service.applyEvent('rw-11', 'rejected', {})).toBe('duplicate');
    expect(await balanceOf(userId)).toBe(afterRefund); // refunded once

    const { rows } = await ctx.db.execute<{ rejection_reason: string }>(
      sql`SELECT rejection_reason FROM transactions WHERE id = ${txId}`,
    );
    expect(rows[0].rejection_reason).toContain('not registered');
  });

  it('a rejected event against a row we settled DISAGREES — flag, never guess', async () => {
    const { txId } = await makeApprovedWithdrawal('100');
    await submitted(txId, 'rw-12');
    await service.applyEvent('rw-12', 'completed', {});

    const outcome = await service.applyEvent('rw-12', 'rejected', { adminNotes: 'oops' });
    expect(outcome).toBe('needs-attention');
    const row = await rowOf(txId);
    expect(row.state).toBe('success'); // untouched
    expect(row.rival_needs_attention).toBe(true);
  });

  it('unknown ids and pending echoes are acknowledged without effect', async () => {
    expect(await service.applyEvent('rw-nobody', 'completed', {})).toBe('not-ours');
    expect(await service.applyEvent('rw-nobody', 'pending', {})).toBe('ignored');
  });
});

describe('cancel-after-approve, both shapes', () => {
  it('a never-submitted row cancels locally without touching Rival', async () => {
    const { txId } = await makeApprovedWithdrawal();
    const row = await rowOf(txId);
    await expect(
      service.cancelApproved({
        id: txId,
        rivalWithdrawalId: row.rival_withdrawal_id,
        rivalSubmittedAt: row.rival_submitted_at,
      }),
    ).resolves.toBeUndefined();
    expect(rival.cancelWithdrawal).not.toHaveBeenCalled();
  });

  it('a submitted row asks Rival first; a PROCESSING refusal changes nothing here', async () => {
    const { txId } = await makeApprovedWithdrawal();
    rival.createWithdrawal.mockResolvedValue(rivalRow('rw-20'));
    await service.submitApproved(txId);

    rival.cancelWithdrawal.mockRejectedValue(new Error('CONFLICT: PROCESSING'));
    await expect(
      service.cancelApproved({
        id: txId,
        rivalWithdrawalId: 'rw-20',
        rivalSubmittedAt: new Date(),
      }),
    ).rejects.toThrow(/already processing/i);
    expect((await rowOf(txId)).state).toBe('approved');
  });

  it('a claim still being reconciled refuses cancellation — the create may have landed', async () => {
    const { txId } = await makeApprovedWithdrawal();
    await expect(
      service.cancelApproved({ id: txId, rivalWithdrawalId: null, rivalSubmittedAt: new Date() }),
    ).rejects.toThrow(/in flight/i);
  });
});

describe('the request-time destination gate (Rival’s own rules, applied early)', () => {
  it('refuses a non-phone destination and a malformed Lebanese number', async () => {
    const { rows } = await ctx.db.execute<{ id: string }>(sql`
      INSERT INTO users (email, password_hash, first_name, last_name, verification_level, email_verified)
      VALUES ('rival-wd-gate@spec.test', 'x', 'Gate', 'Client', 1, true) RETURNING id
    `);
    const userId = rows[0].id;
    await wallets.post({
      userId,
      currency: 'USD',
      amount: '500',
      entryType: 'deposit',
      referenceType: 'transaction',
      referenceId: `seed-${userId}`,
    });

    await expect(
      transactions.requestWithdrawal({
        userId,
        amount: '50',
        currency: 'USD',
        destination: 'my whish account',
        methodKey: 'whish',
      }),
    ).rejects.toThrow(/phone number/i);

    // 961 + 7 digits with a non-3 prefix: the exact shape that dies late at
    // Whish as an opaque auth.wrong_phone_format.
    await expect(
      transactions.requestWithdrawal({
        userId,
        amount: '50',
        currency: 'USD',
        destination: '9617075183',
        methodKey: 'whish',
      }),
    ).rejects.toThrow(/Lebanese/i);

    // A valid +961 3 number and a non-Lebanese international both pass.
    await expect(
      transactions.requestWithdrawal({
        userId,
        amount: '50',
        currency: 'USD',
        destination: '+961 3 123 456',
        methodKey: 'whish',
      }),
    ).resolves.toBeTruthy();
    await expect(
      transactions.requestWithdrawal({
        userId,
        amount: '50',
        currency: 'USD',
        destination: '+49 170 1234567',
        methodKey: 'whish',
      }),
    ).resolves.toBeTruthy();
  });
});
