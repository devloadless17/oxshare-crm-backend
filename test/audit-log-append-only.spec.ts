import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { MoneyTestContext, startMoneyTestDb, stopMoneyTestDb } from './money-setup';
import { closeDb, resetDb } from '../src/database/db';
import { auditLog } from '../src/database/schema';

/**
 * D-21: the admin action log is append-only, enforced by the database.
 *
 * `ledger_entries` has carried this guarantee since migration 0002. `audit_log`
 * had only the fact that `AuditLogStore` exposes no `update()` and no
 * `delete()` — a convention, bypassed by any future service, any later
 * migration, any ORM call by someone who has not read the store, and any `psql`
 * session.
 *
 * That is the wrong way round. Of the two tables, the audit log is the one that
 * answers a compliance question ("who approved this payout", "which admin
 * viewed this passport"), and D-21's justification for building it at all is
 * that history not recorded is history lost. History that can be edited is not
 * history either.
 *
 * Tested against a real Postgres because a trigger is not a thing a mock can
 * have. The assertions walk the whole error cause chain rather than matching the
 * top-level message: Drizzle 0.45 wraps driver errors, and the §6.4 ledger test
 * failed for exactly that reason during the upgrade — the trigger was working
 * perfectly and the assertion was reading the wrong layer.
 */

let ctx: MoneyTestContext;

/** True if this error, or anything it wraps, mentions `needle`. */
function causeChainMentions(error: unknown, needle: string): boolean {
  let current: unknown = error;
  for (let depth = 0; current instanceof Error && depth < 10; depth++) {
    if (current.message.includes(needle)) return true;
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}

async function seedEntry(): Promise<string> {
  const [row] = await ctx.db
    .insert(auditLog)
    .values({
      actorId: '11111111-1111-1111-1111-111111111111',
      actorEmail: 'admin@test.local',
      action: 'withdrawal.approve',
      subjectType: 'transaction',
      subjectId: 'tx-1',
      details: { amount: '100.00000000' },
    })
    .returning();
  return row.id;
}

beforeAll(async () => {
  resetDb();
  ctx = await startMoneyTestDb();
  resetDb();
});

afterAll(async () => {
  await closeDb();
  if (ctx) await stopMoneyTestDb(ctx);
});

describe('D-21 — audit_log is append-only at the database level', () => {
  it('accepts an append', async () => {
    const id = await seedEntry();
    expect(id).toBeTruthy();
  });

  it('REFUSES an UPDATE, even from the migration-level connection', async () => {
    const id = await seedEntry();

    // Raw SQL on purpose. The store cannot express this, which was precisely the
    // old "guarantee": the protection lived in the absence of a method rather
    // than in the database. This is the call any future service could make.
    let thrown: unknown;
    try {
      await ctx.db.execute(sql`UPDATE audit_log SET action = 'tampered' WHERE id = ${id}`);
    } catch (error) {
      thrown = error;
    }

    expect(thrown, 'UPDATE on audit_log must be rejected').toBeDefined();
    expect(causeChainMentions(thrown, 'append-only')).toBe(true);
  });

  it('REFUSES a DELETE', async () => {
    const id = await seedEntry();

    let thrown: unknown;
    try {
      await ctx.db.execute(sql`DELETE FROM audit_log WHERE id = ${id}`);
    } catch (error) {
      thrown = error;
    }

    expect(thrown, 'DELETE on audit_log must be rejected').toBeDefined();
    expect(causeChainMentions(thrown, 'append-only')).toBe(true);
  });

  it('leaves the row intact after a refused UPDATE', async () => {
    const id = await seedEntry();

    await ctx.db
      .execute(sql`UPDATE audit_log SET action = 'tampered' WHERE id = ${id}`)
      .catch(() => undefined);

    const rows = await ctx.db.execute(sql`SELECT action FROM audit_log WHERE id = ${id}`);
    // A trigger that raised but let the write through would be worse than none,
    // because the exception would read as proof the row is safe.
    expect((rows.rows[0] as { action: string }).action).toBe('withdrawal.approve');
  });

  it('explains what to do instead, in the error itself', async () => {
    const id = await seedEntry();

    let thrown: unknown;
    try {
      await ctx.db.execute(sql`DELETE FROM audit_log WHERE id = ${id}`);
    } catch (error) {
      thrown = error;
    }

    // The person who hits this is mid-incident. The message names the rule and
    // the alternative rather than only saying "no".
    expect(causeChainMentions(thrown, 'correcting entry')).toBe(true);
  });
});

describe('indexes the audit log is actually queried by', () => {
  it('has an index on every column findAll() filters on', async () => {
    const rows = await ctx.db.execute(
      sql`SELECT indexname FROM pg_indexes WHERE tablename = 'audit_log'`,
    );
    const names = rows.rows.map((r) => (r as { indexname: string }).indexname);

    // subject_type became the important one when KYC document reads started
    // being audited — those are now the highest-volume row type in this table.
    expect(names).toContain('audit_log_subject_type_idx');
    expect(names).toContain('audit_log_actor_idx');
    expect(names).toContain('audit_log_action_idx');
  });

  it('indexes commission accruals by the IB who earned them', async () => {
    const rows = await ctx.db.execute(
      sql`SELECT indexname FROM pg_indexes WHERE tablename = 'commission_accruals'`,
    );
    const names = rows.rows.map((r) => (r as { indexname: string }).indexname);

    // Nothing reads this way yet — IB-11/IB-12 will. Adding it before the
    // queries exist is the whole reason it costs nothing.
    expect(names).toContain('commission_accruals_ib_user_idx');
  });
});
