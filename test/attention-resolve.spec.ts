import { ALL_PERMISSIONS } from './support/all-permissions';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq, sql } from 'drizzle-orm';
import { actingAs, startHttpTestApp, stopHttpTestApp, type HttpTestContext } from './http-setup';
import { PasswordService } from '../src/common/security/password.service';
import {
  adminClientTagScopes,
  admins,
  auditLog,
  clientTagAssignments,
  clientTags,
  notifications,
  roles,
  transactions,
  users,
} from '../src/database/schema';

/**
 * "MARK RESOLVED" — the finish line a payment anomaly never had.
 *
 * An amount mismatch, a reversal, money paid against a failed row, the
 * platform and this side disagreeing: each sets `rival_needs_attention`, and
 * for a deposit NO path ever cleared it. The row said "needs attention" for
 * ever, and the admin task announcing it could never finish (migration 0140
 * makes the task's life the flag's life). This route is the person saying "I
 * reconciled it, here is what I found" — and the proof below is that saying so
 * clears the flag, records the note, and ends the task for everyone, while the
 * money-rule boundaries (who may, which territory) hold.
 */

const MASTER = { email: 'attn-master@oxshare.com', password: 'admin-password-123' };
const DEPOSIT_DESK = { email: 'attn-deposits@oxshare.com', password: 'admin-password-123' };
const NORTH_SETTLER = { email: 'attn-north@oxshare.com', password: 'admin-password-123' };

const NOTE = 'Checked the platform dashboard — the amounts agree; nothing further owed.';

let ctx: HttpTestContext;
let masterId: string;
let northTagId: string;
let southTagId: string;
let seq = 0;

async function client(tag: 'north' | 'south'): Promise<number> {
  seq += 1;
  const [row] = await ctx.db.db
    .insert(users)
    .values({
      email: `attn-${seq}@oxshare-e2e.test`,
      passwordHash: 'x',
      firstName: 'Attn',
      lastName: `C${seq}`,
    })
    .returning();
  await ctx.db.db
    .insert(clientTagAssignments)
    .values({ userId: row.id, tagId: tag === 'north' ? northTagId : southTagId });
  return row.id;
}

/** A payment flagged for a person, with the open admin task that announced it. */
async function flagged(
  clientId: number,
  direction: 'deposit' | 'withdrawal',
): Promise<{ txId: string; taskId: string }> {
  const { rows: wallet } = await ctx.db.db.execute<{ id: string }>(sql`
    INSERT INTO wallets (user_id, currency, balance) VALUES (${clientId}, 'USD', '0') RETURNING id`);
  const { rows: tx } = await ctx.db.db.execute<{ id: string }>(sql`
    INSERT INTO transactions
      (user_id, wallet_id, direction, amount, currency, state, provider, provider_ref,
       rival_needs_attention, rival_attention_reason)
    VALUES (${clientId}, ${wallet[0].id}, ${direction}::transaction_direction, '120.00000000', 'USD',
            'success', 'whish', ${`attn-${seq}-${direction}`}, true,
            'The platform REVERSED this deposit after it settled.')
    RETURNING id`);
  const [task] = await ctx.db.db
    .insert(notifications)
    .values({
      recipientKind: 'admin',
      recipientId: masterId,
      kind: direction === 'deposit' ? 'admin.deposit.attention' : 'withdrawal.rival_attention',
      params: { transactionId: tx[0].id, reason: 'reversed' },
      subjectKind: 'transaction',
      subjectId: tx[0].id,
      subjectUserId: clientId,
    })
    .returning();
  return { txId: tx[0].id, taskId: task.id };
}

const resolvePath = (txId: string) => `/v1/admin/transactions/${txId}/attention/resolve`;

beforeAll(async () => {
  ctx = await startHttpTestApp();
  const db = ctx.db.db;
  const hash = await new PasswordService().hash(MASTER.password);

  const [masterRole] = await db
    .insert(roles)
    .values({ name: 'Attn Master', permissions: ALL_PERMISSIONS, isSystem: true })
    .returning();
  // Deposits only: may resolve a deposit anomaly, never a payout disagreement.
  const [depositRole] = await db
    .insert(roles)
    .values({
      name: 'Attn Deposits',
      permissions: ['deposits.view', 'deposits.approve', 'transactions.view'],
    })
    .returning();
  // Every key the route could want — so a refusal can only be about TERRITORY.
  const [settlerRole] = await db
    .insert(roles)
    .values({
      name: 'Attn Settler',
      permissions: [
        'deposits.approve',
        'withdrawals.settle',
        'withdrawals.approve',
        'transactions.view',
      ],
    })
    .returning();

  const inserted = await db
    .insert(admins)
    .values([
      {
        email: MASTER.email,
        passwordHash: hash,
        name: 'Attn Master',
        role: 'master_admin' as const,
        roleId: masterRole.id,
        permissions: ALL_PERMISSIONS,
      },
      {
        email: DEPOSIT_DESK.email,
        passwordHash: hash,
        name: 'Attn Deposits',
        role: 'sub_admin' as const,
        roleId: depositRole.id,
        permissions: [],
      },
      {
        email: NORTH_SETTLER.email,
        passwordHash: hash,
        name: 'Attn North',
        role: 'sub_admin' as const,
        roleId: settlerRole.id,
        permissions: [],
        seesUntriaged: false,
      },
    ])
    .returning();
  masterId = inserted[0].id;

  const [north] = await db
    .insert(clientTags)
    .values({ slug: 'attn-north', label: 'Attn North' })
    .returning();
  const [south] = await db
    .insert(clientTags)
    .values({ slug: 'attn-south', label: 'Attn South' })
    .returning();
  northTagId = north.id;
  southTagId = south.id;
  await db
    .insert(adminClientTagScopes)
    .values({ adminId: inserted[2].id, tagId: northTagId, createdBy: masterId });
}, 180_000);

afterAll(async () => {
  await stopHttpTestApp(ctx);
});

describe('Mark resolved', () => {
  it('clears the flag, records who and what they found, and ends the task for everyone', async () => {
    const { txId, taskId } = await flagged(await client('north'), 'deposit');
    const master = await actingAs(ctx, 'admin', MASTER);

    const res = await master.patch(resolvePath(txId), { note: NOTE });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ id: txId, needsAttention: false });

    const [row] = await ctx.db.db
      .select({ flag: transactions.rivalNeedsAttention, reason: transactions.rivalAttentionReason })
      .from(transactions)
      .where(eq(transactions.id, txId));
    expect(row).toEqual({ flag: false, reason: null });

    const [audit] = await ctx.db.db
      .select({ details: auditLog.details, actorId: auditLog.actorId })
      .from(auditLog)
      .where(
        and(eq(auditLog.action, 'transaction.attention_resolve'), eq(auditLog.subjectId, txId)),
      );
    expect(audit.actorId).toBe(masterId);
    expect(audit.details).toMatchObject({ note: NOTE, direction: 'deposit' });

    // The task's life was the flag's life — migration 0140's trigger.
    const [task] = await ctx.db.db
      .select({ resolvedAt: notifications.resolvedAt, resolution: notifications.resolution })
      .from(notifications)
      .where(eq(notifications.id, taskId));
    expect(task.resolvedAt).not.toBeNull();
    expect(task.resolution).toBe('resolved');
  });

  it('refuses a payment that is no longer flagged — the second click, or a colleague first', async () => {
    const { txId } = await flagged(await client('north'), 'deposit');
    const master = await actingAs(ctx, 'admin', MASTER);
    expect((await master.patch(resolvePath(txId), { note: NOTE })).status).toBe(200);
    expect((await master.patch(resolvePath(txId), { note: NOTE })).status).toBe(400);
  });

  it('asks for the permission that fits the direction', async () => {
    const deposits = await actingAs(ctx, 'admin', DEPOSIT_DESK);
    const payout = await flagged(await client('north'), 'withdrawal');
    // "Did this payout's money move" is withdrawals.settle's judgement.
    expect((await deposits.patch(resolvePath(payout.txId), { note: NOTE })).status).toBe(403);
    const deposit = await flagged(await client('north'), 'deposit');
    expect((await deposits.patch(resolvePath(deposit.txId), { note: NOTE })).status).toBe(200);
  });

  it('answers NOT FOUND for a payment outside the territory — never a confirming 403', async () => {
    const north = await actingAs(ctx, 'admin', NORTH_SETTLER);
    const outside = await flagged(await client('south'), 'withdrawal');
    const res = await north.patch(resolvePath(outside.txId), { note: NOTE });
    expect(res.status).toBe(404);
    expect(res.status).not.toBe(403);
    // Control: the same admin, the same kind of payment, inside the territory.
    const inside = await flagged(await client('north'), 'withdrawal');
    expect((await north.patch(resolvePath(inside.txId), { note: NOTE })).status).toBe(200);
  });

  it('requires a note worth reading', async () => {
    const { txId } = await flagged(await client('north'), 'deposit');
    const master = await actingAs(ctx, 'admin', MASTER);
    expect((await master.patch(resolvePath(txId), { note: 'ok' })).status).toBe(400);
    expect((await master.patch(resolvePath(txId), {})).status).toBe(400);
  });
});

describe('the Financial page — where a deposit anomaly task lands', () => {
  interface Row {
    id: string;
    needsAttention: boolean;
    attentionReason?: string | null;
  }
  const listPath = (clientId: number, extra = '') =>
    `/v1/admin/transactions?userId=${clientId}${extra}`;

  it('badges the flagged payment with its reason, and attention=true narrows to exactly it', async () => {
    const clientId = await client('north');
    const { txId } = await flagged(clientId, 'deposit');
    // An ordinary deposit beside it, so the narrowing has something to leave out.
    const { rows: ordinary } = await ctx.db.db.execute<{ id: string }>(sql`
      INSERT INTO transactions (user_id, wallet_id, direction, amount, currency, state, provider, provider_ref)
      SELECT ${clientId}, id, 'deposit', '10.00000000', 'USD', 'success', 'whish', ${`attn-plain-${seq}`}
        FROM wallets WHERE user_id = ${clientId}
      RETURNING id`);
    const master = await actingAs(ctx, 'admin', MASTER);

    const all = await master.get(listPath(clientId));
    expect(all.status).toBe(200);
    const items = all.body.items as Row[];
    expect(items.find((row) => row.id === txId)).toMatchObject({
      needsAttention: true,
      attentionReason: 'The platform REVERSED this deposit after it settled.',
    });
    expect(items.find((row) => row.id === ordinary[0].id)).toMatchObject({
      needsAttention: false,
      attentionReason: null,
    });

    const narrowed = await master.get(listPath(clientId, '&attention=true'));
    expect((narrowed.body.items as Row[]).map((row) => row.id)).toEqual([txId]);

    // Resolved: out of the attention view, still in the history, flag down.
    expect((await master.patch(resolvePath(txId), { note: NOTE })).status).toBe(200);
    expect((await master.get(listPath(clientId, '&attention=true'))).body.items).toEqual([]);
    const after = (await master.get(listPath(clientId))).body.items as Row[];
    expect(after.find((row) => row.id === txId)?.needsAttention).toBe(false);
  });

  it('refuses an attention value that is not `true`, like every enum filter there', async () => {
    const master = await actingAs(ctx, 'admin', MASTER);
    expect((await master.get('/v1/admin/transactions?attention=yes')).status).toBe(400);
  });
});
