import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { sql } from 'drizzle-orm';
import { ConfigService } from '@nestjs/config';
import { TransactionsService } from '../src/modules/payments/transactions.service';
import { PaymentMethodsService } from '../src/modules/payments/payment-methods.service';
import {
  CLIENT_SAFE_PROVIDER_REFUSAL,
  PayoutEngine,
} from '../src/modules/payments/core/payout-engine.service';
import { ChannelSwitchesService } from '../src/modules/payments/core/channel-switches.service';
import { PaymentProviderRegistry } from '../src/modules/payments/providers/payment-provider-registry';
import { ManualPaymentProvider } from '../src/modules/payments/providers/manual/manual.provider';
import { RivalPaymentProvider } from '../src/modules/payments/providers/rival/rival.provider';
import type { ProviderNotice } from '../src/modules/payments/providers/payment-provider';
import { ValidationError } from '../src/common/errors/domain-errors';
import type { EmailService } from '../src/modules/email/email.service';
import type { RivalClient } from '../src/modules/payments/providers/rival/rival.client';
import type { RivalConfigService } from '../src/modules/payments/providers/rival/rival-config.service';
import type { ResourceChangedPublisher } from '../src/common/realtime/resource-changed';
import { WalletService } from '../src/modules/wallet/wallet.service';
import { CurrenciesService } from '../src/modules/currencies/currencies.service';
import { AuditLogStore } from '../src/store/audit-log.store';
import { UsersStore } from '../src/store/users.store';
import { auditStubAs } from './audit-stub';
import { emailStub, emailStubAs } from './email-stub';
import { notificationsStub, notificationsStubAs } from './notifications-stub';
import { transferExecutorStubAs, transfersStubAs } from './transfer-chain-stub';
import { gatewayStubAs } from './gateway-stub';
import { startMoneyTestDb, stopMoneyTestDb, type MoneyTestContext } from './money-setup';

/**
 * Rival's payouts through the payments CORE (0173), against real Postgres:
 * the core's `PayoutEngine` driving Rival's real adapter over a mocked HTTP
 * client — the same scenarios Rival's own service was held to, now held by the
 * engine every provider shares.
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
let service: PayoutEngine;

const rival = {
  createWithdrawal: vi.fn(),
  getWithdrawal: vi.fn(),
  cancelWithdrawal: vi.fn(),
  listPendingWithdrawals: vi.fn().mockResolvedValue(pendingPage([])),
};
const rivalConfig = {
  isEnabled: vi.fn().mockResolvedValue(true),
  invalidate: vi.fn(),
};

/** One page of Rival's pending list, as its API wraps it. */
function pendingPage(data: unknown[], totalPages = 1) {
  return { data, meta: { page: 1, pageSize: 100, total: data.length, totalPages } };
}

/** A verified Rival payout notice — a doorbell: the engine re-reads Rival. */
function notice(payoutId: string, event = 'completed'): ProviderNotice {
  return {
    subject: 'payout',
    providerId: payoutId,
    providerType: `withdrawal.${event}`,
    eventType: 'payout.completed',
    kind: 'status',
  };
}
// Untyped, so mock-call assertions do not trip the unbound-method rule.
const notifications = notificationsStub();
const email = emailStub();
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
    new PaymentMethodsService(ctx.db, currencies, auditStubAs(), gatewayStubAs()),
    currencies,
    gatewayStubAs(),
    new ConfigService(),
    emailStubAs(),
    notificationsStubAs(),
    transfersStubAs(),
    transferExecutorStubAs(),
  );
  const registry = new PaymentProviderRegistry([
    new ManualPaymentProvider(),
    new RivalPaymentProvider(
      rival as unknown as RivalClient,
      rivalConfig as unknown as RivalConfigService,
    ),
  ]);
  service = new PayoutEngine(
    ctx.db,
    registry,
    new ChannelSwitchesService(ctx.db, registry),
    transactions,
    new AuditLogStore(ctx.db),
    new UsersStore(ctx.db),
    email as unknown as EmailService,
    notifications,
    resourceChanged as unknown as ResourceChangedPublisher,
    new ConfigService(),
  );
}, 120_000);

afterAll(async () => {
  await stopMoneyTestDb(ctx);
});

beforeEach(async () => {
  vi.clearAllMocks();
  rivalConfig.isEnabled.mockResolvedValue(true);
  rival.listPendingWithdrawals.mockResolvedValue(pendingPage([]));
  await ctx.db.execute(sql`
    INSERT INTO currencies (code, name, symbol, enabled, is_default)
    VALUES ('USD', 'US Dollar', '$', true, true) ON CONFLICT (code) DO NOTHING
  `);
});

let seq = 0;

/** A verified, funded client with an APPROVED whish withdrawal. */
async function makeApprovedWithdrawal(amount = '100'): Promise<{
  txId: string;
  userId: number;
}> {
  seq += 1;
  const { rows } = await ctx.db.execute<{ id: number }>(sql`
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
    provider_payout_id: string | null;
    provider_submitted_at: Date | null;
    needs_attention: boolean;
    attention_reason: string | null;
    provider_ref: string | null;
  }>(sql`SELECT state, provider_payout_id, provider_submitted_at, needs_attention,
               attention_reason, provider_ref
        FROM transactions WHERE id = ${txId}`);
  return rows[0];
}

async function balanceOf(userId: number): Promise<string> {
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
    expect(row.provider_payout_id).toBe('rw-1');
    expect(row.provider_submitted_at).not.toBeNull();
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
    expect(row.provider_payout_id, 'the payout still exists and is recorded').toBe('rw-short');
    expect(row.needs_attention).toBe(true);
    expect(String(row.attention_reason)).toMatch(/98/);
    expect(String(row.attention_reason)).toMatch(/2 USD short/);
  });

  it('a definite refusal clears the claim, flags the row, tells the approvers', async () => {
    const { txId } = await makeApprovedWithdrawal();
    // What Rival's client throws for its INSUFFICIENT_BALANCE refusal.
    rival.createWithdrawal.mockRejectedValue(new ValidationError('INSUFFICIENT_BALANCE at Rival'));

    await service.submitApproved(txId);

    const row = await rowOf(txId);
    expect(row.provider_submitted_at).toBeNull(); // one retry is possible
    expect(row.needs_attention).toBe(true);
    // The operator can read WHY, in the platform's own words, on the row.
    expect(row.attention_reason).toContain('INSUFFICIENT_BALANCE at Rival');
    expect(row.state).toBe('approved'); // the approval itself stands
    expect(notifications.notifyAdmins).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'withdrawal.payout_submit_failed',
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
    expect(row.provider_submitted_at).not.toBeNull(); // HELD
    expect(row.needs_attention).toBe(true);

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
    rival.listPendingWithdrawals.mockResolvedValue(
      pendingPage([rivalRow('rw-orphan', { notes: `crm:${txId}` })]),
    );
    await service.reconcile('rival');

    const row = await rowOf(txId);
    expect(row.provider_payout_id).toBe('rw-orphan');
    expect(row.needs_attention).toBe(false); // resolved
  });

  it('CLEARS a claim the pending list provably lacks, once the window has passed', async () => {
    const { txId } = await makeApprovedWithdrawal();
    const { PaymentIndeterminateError } = await import('../src/common/errors/domain-errors');
    rival.createWithdrawal.mockRejectedValue(new PaymentIndeterminateError('no answer'));
    await service.submitApproved(txId);

    // Fresh claim + empty list: INSIDE the window nothing changes (the create
    // could still be in flight at Rival).
    await service.reconcile('rival');
    expect((await rowOf(txId)).provider_submitted_at).not.toBeNull();

    // Age the claim past the adopt window; now absence is evidence.
    await ctx.db.execute(
      sql`UPDATE transactions SET provider_submitted_at = now() - interval '20 minutes'
          WHERE id = ${txId}`,
    );
    await service.reconcile('rival');
    const row = await rowOf(txId);
    expect(row.provider_submitted_at).toBeNull();
    expect(row.needs_attention).toBe(true);
  });

  it('holds every claim when the pending list itself is unavailable', async () => {
    const { txId } = await makeApprovedWithdrawal();
    const { PaymentIndeterminateError } = await import('../src/common/errors/domain-errors');
    rival.createWithdrawal.mockRejectedValue(new PaymentIndeterminateError('no answer'));
    await service.submitApproved(txId);
    await ctx.db.execute(
      sql`UPDATE transactions SET provider_submitted_at = now() - interval '20 minutes'
          WHERE id = ${txId}`,
    );

    rival.listPendingWithdrawals.mockRejectedValue(new Error('rival down'));
    await service.reconcile('rival');
    // Cannot judge absence without the list: the claim survives.
    expect((await rowOf(txId)).provider_submitted_at).not.toBeNull();
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

    rival.getWithdrawal.mockResolvedValue(
      rivalRow('rw-10', { status: 'COMPLETED', externalReference: 'whish-tx-991' }),
    );
    const outcome = await service.onNotice('rival', notice('rw-10'));
    expect(outcome).toBe('applied');

    const row = await rowOf(txId);
    expect(row.state).toBe('success');
    expect(row.provider_ref).toBe('whish-tx-991');
    expect(await balanceOf(userId)).toBe(debited);

    // At-least-once: the echo is a no-op.
    expect(await service.onNotice('rival', notice('rw-10'))).toBe('duplicate');
  });

  it('rejected refunds EXACTLY once, with Rival’s reason, under replay', async () => {
    const { txId, userId } = await makeApprovedWithdrawal('100');
    await submitted(txId, 'rw-11');
    const beforeRefund = await balanceOf(userId);

    rival.getWithdrawal.mockResolvedValue(
      rivalRow('rw-11', {
        status: 'REJECTED',
        adminNotes: 'Recipient number is not registered with Whish',
      }),
    );
    const outcome = await service.onNotice('rival', notice('rw-11', 'rejected'));
    expect(outcome).toBe('applied');

    const row = await rowOf(txId);
    expect(row.state).toBe('failure');
    // The hold released and the debit compensated: the client is whole again.
    const afterRefund = await balanceOf(userId);
    expect(Number.parseFloat(afterRefund) > Number.parseFloat(beforeRefund)).toBe(true);

    expect(await service.onNotice('rival', notice('rw-11', 'rejected'))).toBe('duplicate');
    expect(await balanceOf(userId)).toBe(afterRefund); // refunded once

    const { rows } = await ctx.db.execute<{ rejection_reason: string }>(
      sql`SELECT rejection_reason FROM transactions WHERE id = ${txId}`,
    );
    expect(rows[0].rejection_reason).toBe(CLIENT_SAFE_PROVIDER_REFUSAL);
  });

  it('Rival’s operator notes never reach the client — bell, email or stored reason', async () => {
    const { txId } = await makeApprovedWithdrawal('100');
    await submitted(txId, 'rw-13');
    const secret = 'AML flag, matches watchlist';
    vi.mocked(notifications.notify).mockClear();
    email.sendWithdrawalDecisionEmail.mockClear();

    rival.getWithdrawal.mockResolvedValue(
      rivalRow('rw-13', { status: 'REJECTED', adminNotes: secret }),
    );
    expect(await service.onNotice('rival', notice('rw-13', 'rejected'))).toBe('applied');
    await vi.waitFor(() => expect(email.sendWithdrawalDecisionEmail).toHaveBeenCalled());

    const toClient = vi
      .mocked(notifications.notify)
      .mock.calls.filter(
        ([n]) => (n as { recipient: { kind: string } }).recipient.kind === 'client',
      );
    expect(toClient).toHaveLength(1);
    expect(JSON.stringify(toClient.map((call): unknown => call[0]))).not.toContain('AML');
    expect(JSON.stringify(email.sendWithdrawalDecisionEmail.mock.calls)).not.toContain('AML');

    // The note is kept for the desk: its own admin-only column, and the audit row.
    const { rows } = await ctx.db.execute<{ details: { providerNote?: string } }>(
      sql`SELECT details FROM audit_log WHERE subject_id = ${txId}
          AND action = 'withdrawal.provider.reject'`,
    );
    expect(rows[0].details.providerNote).toBe(secret);
    const stored = await ctx.db.execute<{ provider_note: string; rejection_reason: string }>(
      sql`SELECT provider_note, rejection_reason FROM transactions WHERE id = ${txId}`,
    );
    expect(stored.rows[0]).toEqual({
      provider_note: secret,
      rejection_reason: CLIENT_SAFE_PROVIDER_REFUSAL,
    });

    // The admin desk reads it; the client's own history never carries it.
    const owner = await ctx.db.execute<{ user_id: number }>(
      sql`SELECT user_id FROM transactions WHERE id = ${txId}`,
    );
    const mine = await transactions.listForUser(owner.rows[0].user_id);
    expect(JSON.stringify(mine)).not.toContain('AML');
    const desk = await transactions.listForAdmin({ id: txId });
    expect(desk.items.find((w) => w.id === txId)?.providerNote).toBe(secret);
  });

  it('a rejected event against a row we settled DISAGREES — flag, never guess', async () => {
    const { txId } = await makeApprovedWithdrawal('100');
    await submitted(txId, 'rw-12');
    rival.getWithdrawal.mockResolvedValue(rivalRow('rw-12', { status: 'COMPLETED' }));
    await service.onNotice('rival', notice('rw-12'));

    rival.getWithdrawal.mockResolvedValue(
      rivalRow('rw-12', { status: 'REJECTED', adminNotes: 'oops' }),
    );
    const outcome = await service.onNotice('rival', notice('rw-12', 'rejected'));
    expect(outcome).toBe('needs-attention');
    const row = await rowOf(txId);
    expect(row.state).toBe('success'); // untouched
    expect(row.needs_attention).toBe(true);
  });

  it('unknown ids and a still-pending re-read are acknowledged without effect', async () => {
    expect(await service.onNotice('rival', notice('rw-nobody'))).toBe('not-ours');

    const { txId } = await makeApprovedWithdrawal('100');
    await submitted(txId, 'rw-14');
    rival.getWithdrawal.mockResolvedValue(rivalRow('rw-14', { status: 'PENDING' }));
    expect(await service.onNotice('rival', notice('rw-14'))).toBe('ignored');
    expect((await rowOf(txId)).state).toBe('approved');
  });

  it('a notice CLAIMING completion changes nothing while Rival says otherwise (the doorbell rule)', async () => {
    const { txId } = await makeApprovedWithdrawal('100');
    await submitted(txId, 'rw-15');
    // The delivery says "completed"; Rival's own API still says PENDING.
    rival.getWithdrawal.mockResolvedValue(rivalRow('rw-15', { status: 'PENDING' }));
    await service.onNotice('rival', notice('rw-15', 'completed'));
    expect((await rowOf(txId)).state).toBe('approved');
  });
});

describe('cancel-after-approve, both shapes', () => {
  it('a never-submitted row cancels locally without touching Rival', async () => {
    const { txId } = await makeApprovedWithdrawal();
    await expect(service.cancelApproved(await transactions.getById(txId))).resolves.toBeUndefined();
    expect(rival.cancelWithdrawal).not.toHaveBeenCalled();
  });

  it('a submitted row asks Rival first; a PROCESSING refusal changes nothing here', async () => {
    const { txId } = await makeApprovedWithdrawal();
    rival.createWithdrawal.mockResolvedValue(rivalRow('rw-20'));
    await service.submitApproved(txId);

    rival.cancelWithdrawal.mockRejectedValue(new Error('CONFLICT: PROCESSING'));
    await expect(service.cancelApproved(await transactions.getById(txId))).rejects.toThrow(
      /already processing/i,
    );
    expect((await rowOf(txId)).state).toBe('approved');
  });

  it('a claim still being reconciled refuses cancellation — the create may have landed', async () => {
    const { txId } = await makeApprovedWithdrawal();
    const row = await transactions.getById(txId);
    await expect(
      service.cancelApproved({ ...row, providerPayoutId: null, providerSubmittedAt: new Date() }),
    ).rejects.toThrow(/in flight/i);
  });
});

describe('the request-time destination gate (Rival’s own rules, applied early)', () => {
  it('refuses a non-phone destination and a malformed Lebanese number', async () => {
    const { rows } = await ctx.db.execute<{ id: number }>(sql`
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

describe('what the core changed (0173)', () => {
  it('an UNEXPECTED adapter error holds the claim — the safe side of "did it pay?"', async () => {
    const { txId } = await makeApprovedWithdrawal();
    rival.createWithdrawal.mockRejectedValue(new TypeError('socket hang up mid-parse'));

    await service.submitApproved(txId);
    const row = await rowOf(txId);
    expect(row.provider_submitted_at, 'held, never released on a guess').not.toBeNull();
    expect(row.needs_attention).toBe(true);
  });

  it('adopts an orphan on the SECOND page of Rival’s pending list', async () => {
    /*
     * The scan used to read one page of 100 and call anything not on it
     * absent — so with more than 100 payouts pending, an orphan that existed
     * was cleared for a resend: a double payout waiting for a click.
     */
    const { txId } = await makeApprovedWithdrawal();
    const { PaymentIndeterminateError } = await import('../src/common/errors/domain-errors');
    rival.createWithdrawal.mockRejectedValue(new PaymentIndeterminateError('no answer'));
    await service.submitApproved(txId);

    rival.listPendingWithdrawals.mockImplementation((page: number) =>
      Promise.resolve(
        page === 1
          ? pendingPage([rivalRow('rw-other', { notes: 'crm:somebody-else' })], 2)
          : pendingPage([rivalRow('rw-page2', { notes: `crm:${txId}` })], 2),
      ),
    );
    await service.reconcile('rival');

    expect((await rowOf(txId)).provider_payout_id).toBe('rw-page2');
    expect(rival.listPendingWithdrawals).toHaveBeenCalledWith(2);
  });
});
