import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { MoneyTestContext, startMoneyTestDb, stopMoneyTestDb } from './money-setup';
import { closeDb, getDb, resetDb } from '../src/database/db';
import { auditLog, ibPrograms, transactions, users } from '../src/database/schema';
import { WalletService } from '../src/modules/wallet/wallet.service';
import { TransactionsService } from '../src/modules/payments/transactions.service';
import { MoneyLimits } from '../src/config/money-limits';
import { ProgramsService } from '../src/modules/partners/programs.service';
import { AdminAuditService } from '../src/modules/admin/admin-audit.service';
import { AdminsStore } from '../src/store/admins.store';
import { AuditLogStore } from '../src/store/audit-log.store';

/**
 * The audit row for a money movement commits with the money — R-6.5.
 *
 * `AdminAuditService.record()` is fire-and-forget by design, and for a role
 * rename that is right: the action succeeded, and losing the record should not
 * undo it. For approving or settling a withdrawal it is wrong. The money moves,
 * the audit row is lost, and the answer to "who approved this payout" is a log
 * line that may itself have rotated — while D-21's whole justification is that
 * this is the one record which cannot be reconstructed afterwards.
 *
 * The withdrawal lifecycle now takes a `withinTx` hook that runs inside the
 * transaction which moves the money. These tests prove both halves of that:
 * on success the two commit together, and on an audit FAILURE the money movement
 * rolls back rather than proceeding unrecorded.
 *
 * The second is the one that matters and the one no unit test can fake: it needs
 * a real transaction to roll back, so this runs against Testcontainers Postgres.
 */

let ctx: MoneyTestContext;
let wallets: WalletService;
let txService: TransactionsService;
let programs: ProgramsService;
let audit: AdminAuditService;

const ADMIN_ID = '22222222-2222-2222-2222-222222222222';

async function makeFundedUser(email: string): Promise<string> {
  const [row] = await ctx.db
    .insert(users)
    .values({
      email,
      passwordHash: 'x',
      firstName: 'Test',
      lastName: 'User',
      verificationLevel: 1,
    })
    .returning();
  await wallets.post({
    userId: row.id,
    currency: 'USD',
    amount: '1000.00000000',
    entryType: 'deposit',
    referenceType: 'seed',
    referenceId: `seed-${row.id}`,
  });
  return row.id;
}

/** A pending withdrawal with its funds already on hold. */
async function requestWithdrawal(userId: string): Promise<string> {
  const row = await txService.requestWithdrawal({
    userId,
    amount: '100.00000000',
    currency: 'USD',
    destination: 'IBAN-TEST',
    provider: 'whish',
  });
  return row.id;
}

beforeAll(async () => {
  resetDb();
  ctx = await startMoneyTestDb();
  resetDb();
  wallets = new WalletService(getDb());
  // Real limits reading the documented defaults, as money-atomicity.spec does:
  // the §12.4 ceilings are part of what a withdrawal must satisfy, so a stub
  // would let this pass on amounts production refuses.
  txService = new TransactionsService(
    wallets,
    getDb(),
    new MoneyLimits({
      get: () => undefined,
    } as never),
  );
  programs = new ProgramsService(getDb());
  // The real audit service against the real stores: the point of these tests is
  // that the row lands in the same transaction, which a stub cannot demonstrate.
  audit = new AdminAuditService(new AdminsStore(getDb()), new AuditLogStore(getDb()));
});

afterAll(async () => {
  await closeDb();
  if (ctx) await stopMoneyTestDb(ctx);
});

describe('R-6.5 — the audit row and the money movement commit together', () => {
  it('writes the audit row inside the approving transaction', async () => {
    const userId = await makeFundedUser('approve-ok@test.local');
    const withdrawalId = await requestWithdrawal(userId);

    await txService.approve(withdrawalId, ADMIN_ID, async (tx, row) => {
      await tx.insert(auditLog).values({
        actorId: ADMIN_ID,
        actorEmail: 'admin@test.local',
        action: 'withdrawal.approve',
        subjectType: 'transaction',
        subjectId: row.id,
        details: { amount: row.amount },
      });
    });

    const [tx] = await ctx.db.select().from(transactions).where(eq(transactions.id, withdrawalId));
    expect(tx.state).toBe('approved');

    const audits = await ctx.db.select().from(auditLog).where(eq(auditLog.subjectId, withdrawalId));
    expect(audits).toHaveLength(1);
    expect(audits[0].action).toBe('withdrawal.approve');
  });

  it('ROLLS BACK the approval when the audit row cannot be written', async () => {
    const userId = await makeFundedUser('approve-fail@test.local');
    const withdrawalId = await requestWithdrawal(userId);

    await expect(
      txService.approve(withdrawalId, ADMIN_ID, () => {
        // Whatever the reason — the log store is unreachable, a constraint
        // fires, the append-only trigger rejects a bad write — the money must
        // not move unrecorded.
        return Promise.reject(new Error('audit store unavailable'));
      }),
    ).rejects.toThrow('audit store unavailable');

    const [tx] = await ctx.db.select().from(transactions).where(eq(transactions.id, withdrawalId));
    // THE assertion. Before this change the transition committed on its own and
    // the detached audit write failed silently afterwards, leaving an approved
    // withdrawal nobody is accountable for.
    expect(tx.state).toBe('pending');
  });

  /*
   * Commission plans, which the first pass of this work left behind.
   *
   * A plan is not itself a money movement, which is why these kept the
   * fire-and-forget `record()` while approve/reject/settle were moved. But a
   * plan decides what every future accrual PAYS: changing an L1 share re-prices
   * commission for every deal that follows. If the change commits and the record
   * is lost, the accruals it produced are correct with respect to a rule nobody
   * can attribute — and the before/after pair, which is the only thing that
   * makes a rate change reviewable, cannot be reconstructed from the row.
   */
  describe('commission plan writes', () => {
    const planInput = (name: string, l1Share: string) => ({
      name,
      mode: 'commission' as const,
      method: 'spread_share' as const,
      commissionValue: '30',
      rebateValue: '0',
      l1Share,
      l2Share: '0',
      settlementWindowHours: 24,
      rebateOnClose: false,
      position: 1,
      selectable: true,
    });

    it('writes the audit row inside the creating transaction', async () => {
      const row = await programs.create(planInput('Audited Plan', '70'), (tx, created) =>
        audit.recordWithin(tx, ADMIN_ID, 'program.create', 'ib_program', created.id, {
          l1Share: created.l1Share,
        }),
      );

      const audits = await ctx.db.select().from(auditLog).where(eq(auditLog.subjectId, row.id));
      expect(audits).toHaveLength(1);
      expect(audits[0].action).toBe('program.create');
    });

    it('ROLLS BACK a plan whose audit row cannot be written', async () => {
      await expect(
        programs.create(planInput('Unaudited Plan', '70'), () =>
          Promise.reject(new Error('audit store unavailable')),
        ),
      ).rejects.toThrow('audit store unavailable');

      // THE assertion: no plan exists. Before this, the insert committed and the
      // detached audit write failed silently afterwards.
      const rows = await ctx.db
        .select()
        .from(ibPrograms)
        .where(eq(ibPrograms.name, 'Unaudited Plan'));
      expect(rows).toHaveLength(0);
    });

    it('ROLLS BACK a rate change whose audit row cannot be written', async () => {
      // The one that costs the most: an unattributable change to what every
      // future accrual pays.
      const created = await programs.create(planInput('Rate Change Plan', '70'));

      await expect(
        programs.update(created.id, planInput('Rate Change Plan', '95'), () =>
          Promise.reject(new Error('audit store unavailable')),
        ),
      ).rejects.toThrow('audit store unavailable');

      const [row] = await ctx.db.select().from(ibPrograms).where(eq(ibPrograms.id, created.id));
      expect(row.l1Share).toBe('70.00');
    });

    it('ROLLS BACK a deactivation whose audit row cannot be written', async () => {
      const created = await programs.create(planInput('Deactivate Plan', '70'));

      await expect(
        programs.setActive(created.id, false, () =>
          Promise.reject(new Error('audit store unavailable')),
        ),
      ).rejects.toThrow('audit store unavailable');

      const [row] = await ctx.db.select().from(ibPrograms).where(eq(ibPrograms.id, created.id));
      expect(row.active).toBe(true);
    });
  });

  it('rolls back the settlement, the ledger debit AND the hold release together', async () => {
    const userId = await makeFundedUser('settle-fail@test.local');
    const withdrawalId = await requestWithdrawal(userId);
    await txService.approve(withdrawalId, ADMIN_ID);

    const before = await walletSnapshot(userId);

    await expect(
      txService.settle(withdrawalId, ADMIN_ID, 'provider-ref-1', () =>
        Promise.reject(new Error('audit store unavailable')),
      ),
    ).rejects.toThrow('audit store unavailable');

    const [tx] = await ctx.db.select().from(transactions).where(eq(transactions.id, withdrawalId));
    expect(tx.state).toBe('approved');

    // Settlement posts a debit and clears the hold. Both must be undone with the
    // state change — a partial rollback here is money duplicated or funds frozen.
    expect(await walletSnapshot(userId)).toEqual(before);
  });

  it('releases the hold and records the rejection atomically', async () => {
    const userId = await makeFundedUser('reject-ok@test.local');
    const withdrawalId = await requestWithdrawal(userId);

    await txService.reject(withdrawalId, ADMIN_ID, 'Beneficiary mismatch', async (tx, row) => {
      await tx.insert(auditLog).values({
        actorId: ADMIN_ID,
        actorEmail: 'admin@test.local',
        action: 'withdrawal.reject',
        subjectType: 'transaction',
        subjectId: row.id,
      });
    });

    const audits = await ctx.db.select().from(auditLog).where(eq(auditLog.subjectId, withdrawalId));
    expect(audits).toHaveLength(1);

    const snapshot = await walletSnapshot(userId);
    expect(snapshot.onHold).toBe('0.00000000');
  });

  it('still works with no hook, for callers that are not admin actions', async () => {
    const userId = await makeFundedUser('no-hook@test.local');
    const withdrawalId = await requestWithdrawal(userId);

    // The provider callback path has no admin actor and passes nothing.
    const row = await txService.approve(withdrawalId, ADMIN_ID);
    expect(row.state).toBe('approved');
  });
});

async function walletSnapshot(userId: string): Promise<{ balance: string; onHold: string }> {
  const rows = await ctx.db.execute(
    sql`SELECT balance::text, on_hold::text FROM wallets WHERE user_id = ${userId} AND currency = 'USD'`,
  );
  const row = rows.rows[0] as { balance: string; on_hold: string };
  return { balance: row.balance, onHold: row.on_hold };
}
