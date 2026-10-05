import { ALL_PERMISSIONS } from './support/all-permissions';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq, sql } from 'drizzle-orm';
import {
  actingAs,
  startHttpTestApp,
  stopHttpTestApp,
  type HttpTestContext,
  type Session,
} from './http-setup';
import { PasswordService } from '../src/common/security/password.service';
import {
  adminClientTagScopes,
  admins,
  auditLog,
  clientTagAssignments,
  clientTags,
  kycSubmissions,
  notifications,
  roles,
  users,
  type NotificationSubjectKind,
} from '../src/database/schema';
import { NotificationsService } from '../src/modules/notifications/notifications.service';

/**
 * ADMIN NOTIFICATIONS ARE TASKS — the owner's rules, through the real HTTP
 * stack (guards, CSRF, the RBAC-03 mask) against real Postgres (migration
 * 0140's triggers).
 *
 * The broker's words, each pinned below by the property that makes it true:
 *
 *  1. "Only for the clients in my scope" — scope is re-checked on EVERY read,
 *     so a task fanned out before a re-tag stops being visible the moment the
 *     client leaves the desk's territory (it used to linger 90 days).
 *  2. "Only what I can act on" — the kind's permission is re-checked on every
 *     read too; revoke it and the tasks go.
 *  3. "When it's handled it should disappear" — ONE admin's decision resolves
 *     the task in EVERY admin's inbox, by trigger, and a claim does not.
 *  4. "Clicking it is not handling it" (5 Oct 2026, reversing "read means
 *     gone") — opening a task marks it SEEN, for the reader alone; it stays in
 *     every inbox, and on the badge, until the item is decided.
 *  5. "Keep the old ones" — history keeps every HANDLED task, with its
 *     outcome; a task still waiting is in the inbox and nowhere else.
 *
 * Every negative assertion sits beside a positive control, so "the desk sees
 * nothing" cannot pass against a feed that is simply broken.
 */

const MASTER = { email: 'tasks-master@oxshare.com', password: 'admin-password-123' };
const DESK = { email: 'tasks-desk@oxshare.com', password: 'admin-password-123' };
const MASKED = { email: 'tasks-masked@oxshare.com', password: 'admin-password-123' };

let ctx: HttpTestContext;
let masterId: string;
let deskId: string;
let maskedId: string;
let deskRoleId: string;
let northTagId: string;
let southTagId: string;
let clientSeq = 0;

interface Task {
  id: string;
  kind: string;
  category: string;
  readAt: string | null;
  subject: { kind: string; id: string };
  client: { portalId: number | null; firstName?: string | null; lastName?: string | null };
  resolution: { at: string; outcome: string; byName?: string | null } | null;
}
interface Feed {
  items: Task[];
  nextCursor: string | null;
  maskedFields: string[];
}
interface Summary {
  count: number;
  byCategory: Record<string, number>;
}

const DESK_PERMISSIONS = [
  'kyc.view',
  'kyc.review',
  'withdrawals.view',
  'withdrawals.approve',
  'withdrawals.settle',
  'deposits.view',
  'deposits.approve',
];

/** A client, optionally in one of the two territories, with a KYC awaiting review. */
async function client(tag?: 'north' | 'south'): Promise<number> {
  clientSeq += 1;
  const db = ctx.db.db;
  const [row] = await db
    .insert(users)
    .values({
      email: `tasks-client-${clientSeq}@oxshare-e2e.test`,
      passwordHash: 'x',
      firstName: 'Task',
      lastName: `Client${clientSeq}`,
    })
    .returning();
  if (tag) {
    await db
      .insert(clientTagAssignments)
      .values({ userId: row.id, tagId: tag === 'north' ? northTagId : southTagId });
  }
  await db
    .insert(kycSubmissions)
    .values({ userId: row.id, status: 'submitted', submittedAt: new Date() });
  return row.id;
}

/** Move a client into exactly one territory. */
async function retag(clientId: number, tag: 'north' | 'south') {
  const db = ctx.db.db;
  await db.delete(clientTagAssignments).where(eq(clientTagAssignments.userId, clientId));
  await db
    .insert(clientTagAssignments)
    .values({ userId: clientId, tagId: tag === 'north' ? northTagId : southTagId });
}

/**
 * A task row written directly — the READ path under test, bypassing the
 * fan-out. It stands for a row fanned out BEFORE something changed (a re-tag,
 * a revoked key), which is exactly the row the read path must now judge.
 */
async function seedTask(
  adminId: string,
  kind: string,
  subject: { kind: NotificationSubjectKind; id: string; clientId: number },
  createdAt?: Date,
): Promise<string> {
  const [row] = await ctx.db.db
    .insert(notifications)
    .values({
      recipientKind: 'admin',
      recipientId: adminId,
      kind,
      params: { amount: '10.00000000', currency: 'USD' },
      subjectKind: subject.kind,
      subjectId: subject.id,
      subjectUserId: subject.clientId,
      ...(createdAt ? { createdAt } : {}),
    })
    .returning();
  return row.id;
}

const kycOf = (clientId: number) => ({ kind: 'kyc' as const, id: String(clientId), clientId });

/** Defaults to the inbox: every task seeded here is still waiting, so that is where it lives. */
async function feed(session: Session, query = 'view=inbox&limit=100'): Promise<Feed> {
  const res = await session.get(`/v1/admin/notifications?${query}`);
  expect(res.status).toBe(200);
  return res.body as Feed;
}

const ids = (f: Feed) => f.items.map((t) => t.id);

async function summary(session: Session): Promise<Summary> {
  const res = await session.get('/v1/admin/notifications/unread-count');
  expect(res.status).toBe(200);
  return res.body as Summary;
}

beforeAll(async () => {
  ctx = await startHttpTestApp();
  const db = ctx.db.db;
  const hash = await new PasswordService().hash(MASTER.password);

  const [masterRole] = await db
    .insert(roles)
    .values({ name: 'Tasks Master', permissions: ALL_PERMISSIONS, isSystem: true })
    .returning();
  const [deskRole] = await db
    .insert(roles)
    .values({ name: 'Tasks Desk', permissions: DESK_PERMISSIONS })
    .returning();
  const [maskedRole] = await db
    .insert(roles)
    .values({
      name: 'Tasks Masked',
      permissions: ALL_PERMISSIONS,
      maskedFields: ['client.firstName', 'client.lastName'],
    })
    .returning();
  deskRoleId = deskRole.id;

  const inserted = await db
    .insert(admins)
    .values([
      {
        email: MASTER.email,
        passwordHash: hash,
        name: 'Tasks Master',
        role: 'master_admin' as const,
        roleId: masterRole.id,
        permissions: ALL_PERMISSIONS,
      },
      {
        email: DESK.email,
        passwordHash: hash,
        name: 'Tasks Desk',
        role: 'sub_admin' as const,
        roleId: deskRole.id,
        permissions: [],
        // Territory only — no intake pool, so an untagged client is outside.
        seesUntriaged: false,
      },
      {
        email: MASKED.email,
        passwordHash: hash,
        name: 'Tasks Masked',
        role: 'sub_admin' as const,
        roleId: maskedRole.id,
        permissions: [],
      },
    ])
    .returning();
  [masterId, deskId, maskedId] = inserted.map((a) => a.id);

  const [north] = await db
    .insert(clientTags)
    .values({ slug: 'tasks-north', label: 'Tasks North' })
    .returning();
  const [south] = await db
    .insert(clientTags)
    .values({ slug: 'tasks-south', label: 'Tasks South' })
    .returning();
  northTagId = north.id;
  southTagId = south.id;
  await db
    .insert(adminClientTagScopes)
    .values({ adminId: deskId, tagId: northTagId, createdBy: masterId });
}, 180_000);

afterAll(async () => {
  await stopHttpTestApp(ctx);
});

describe('the fan-out rings exactly who could act — and nobody for a handled item', () => {
  it('a KYC submission reaches the unrestricted and the in-territory reviewers only', async () => {
    const service = ctx.app.get(NotificationsService);
    const northClient = await client('north');
    const southClient = await client('south');

    await service.notifyAdmins({
      kind: 'admin.kyc.submitted',
      params: { userId: northClient },
      subject: kycOf(northClient),
    });
    await service.notifyAdmins({
      kind: 'admin.kyc.submitted',
      params: { userId: southClient },
      subject: kycOf(southClient),
    });

    const recipientsOf = async (clientId: number) =>
      (
        await ctx.db.db
          .select({ recipientId: notifications.recipientId })
          .from(notifications)
          .where(
            and(
              eq(notifications.subjectKind, 'kyc'),
              eq(notifications.subjectId, String(clientId)),
            ),
          )
      ).map((r) => r.recipientId);

    const north = await recipientsOf(northClient);
    expect(north).toEqual(expect.arrayContaining([masterId, deskId, maskedId]));
    const south = await recipientsOf(southClient);
    expect(south).toEqual(expect.arrayContaining([masterId, maskedId]));
    expect(south, 'a south client rang the north desk').not.toContain(deskId);
  });

  it('writes nothing for an item already handled before the fan-out landed', async () => {
    const service = ctx.app.get(NotificationsService);
    const decided = await client('north');
    await ctx.db.db
      .update(kycSubmissions)
      .set({ status: 'approved' })
      .where(eq(kycSubmissions.userId, decided));

    await service.notifyAdmins({
      kind: 'admin.kyc.submitted',
      params: { userId: decided },
      subject: kycOf(decided),
    });

    const [{ n }] = await ctx.db.db
      .select({ n: sql<number>`count(*)::int` })
      .from(notifications)
      .where(
        and(eq(notifications.subjectKind, 'kyc'), eq(notifications.subjectId, String(decided))),
      );
    expect(n).toBe(0);
  });
});

describe('read-time scope — a row that survived a re-tag is not a row the reader may see', () => {
  it('re-tagging the client out of the desk removes the task from list, badge and markers at once', async () => {
    const mover = await client('north');
    const taskId = await seedTask(deskId, 'admin.kyc.submitted', kycOf(mover));
    const desk = await actingAs(ctx, 'admin', DESK);

    // Control: in territory, the task is there and counted.
    expect(ids(await feed(desk, 'view=inbox&limit=100'))).toContain(taskId);
    const before = (await summary(desk)).byCategory['kyc'];

    await retag(mover, 'south');
    expect(ids(await feed(desk)), 'the row outlived the re-tag').not.toContain(taskId);
    expect((await summary(desk)).byCategory['kyc']).toBe(before - 1);
    // A marker aimed at it: absent, never "forbidden" — no existence oracle.
    const marked = await desk.post(`/v1/admin/notifications/${taskId}/read`, {});
    expect(marked.status).toBe(404);

    // And back: the same row, unread, as it was.
    await retag(mover, 'north');
    const restored = (await feed(desk, 'view=inbox&limit=100')).items.find((t) => t.id === taskId);
    expect(restored?.readAt).toBeNull();
  });

  it('matches the desks’ own rule: a client tagged into ANY of the territory’s tags is in', async () => {
    const both = await client('south');
    await ctx.db.db.insert(clientTagAssignments).values({ userId: both, tagId: northTagId });
    const taskId = await seedTask(deskId, 'admin.kyc.submitted', kycOf(both));
    const desk = await actingAs(ctx, 'admin', DESK);
    expect(ids(await feed(desk))).toContain(taskId);
  });

  it('an untagged client is outside a desk without the intake grant', async () => {
    const untagged = await client();
    const taskId = await seedTask(deskId, 'admin.kyc.submitted', kycOf(untagged));
    const desk = await actingAs(ctx, 'admin', DESK);
    expect(ids(await feed(desk))).not.toContain(taskId);
    // Control: the unrestricted reader holding a row about the same client sees it.
    const masterTask = await seedTask(masterId, 'admin.kyc.submitted', kycOf(untagged));
    const master = await actingAs(ctx, 'admin', MASTER);
    expect(ids(await feed(master))).toContain(masterTask);
  });
});

describe('read-time permission — you see the tasks you can act on NOW', () => {
  it('revoking a kind’s permission removes its tasks on the next request, and restoring returns them', async () => {
    const holder = await client('north');
    const kycTask = await seedTask(deskId, 'admin.kyc.resubmitted', kycOf(holder));
    const withdrawalTask = await seedTask(deskId, 'admin.withdrawal.requested', {
      kind: 'transaction',
      id: '00000000-0000-4000-8000-00000000abcd',
      clientId: holder,
    });
    const desk = await actingAs(ctx, 'admin', DESK);
    expect(ids(await feed(desk))).toEqual(expect.arrayContaining([kycTask, withdrawalTask]));

    await ctx.db.db
      .update(roles)
      .set({ permissions: DESK_PERMISSIONS.filter((p) => p !== 'kyc.review') })
      .where(eq(roles.id, deskRoleId));
    try {
      const after = ids(await feed(desk));
      expect(after, 'a revoked key still showed its tasks').not.toContain(kycTask);
      expect(after).toContain(withdrawalTask);
    } finally {
      await ctx.db.db
        .update(roles)
        .set({ permissions: DESK_PERMISSIONS })
        .where(eq(roles.id, deskRoleId));
    }
    expect(ids(await feed(desk))).toContain(kycTask);
  });

  it('shows a kind only to its catalogue holders — clawbacks are not the KYC desk’s', async () => {
    const earner = await client('north');
    const clawback = await seedTask(deskId, 'admin.commission.clawback', {
      kind: 'ib_accrual',
      id: '00000000-0000-4000-8000-0000000c1a3b',
      clientId: earner,
    });
    const desk = await actingAs(ctx, 'admin', DESK);
    expect(ids(await feed(desk))).not.toContain(clawback);
  });
});

describe('handled means gone — for everybody, by the database', () => {
  it('one admin’s decision clears the task from EVERY inbox, and history says who and how', async () => {
    const service = ctx.app.get(NotificationsService);
    const applicant = await client('north');
    await service.notifyAdmins({
      kind: 'admin.kyc.submitted',
      params: { userId: applicant },
      subject: kycOf(applicant),
    });

    const desk = await actingAs(ctx, 'admin', DESK);
    const master = await actingAs(ctx, 'admin', MASTER);
    const deskTask = (await feed(desk, 'view=inbox&limit=100')).items.find(
      (t) => t.subject.id === String(applicant),
    );
    expect(deskTask, 'the desk never got the task').toBeDefined();

    // The master approves — the same UPDATE the approval path writes.
    await ctx.db.db
      .update(kycSubmissions)
      .set({ status: 'approved', reviewedBy: masterId, reviewedAt: new Date() })
      .where(eq(kycSubmissions.userId, applicant));

    for (const session of [desk, master]) {
      const inbox = await feed(session, 'view=inbox&limit=100');
      expect(
        inbox.items.some((t) => t.subject.id === String(applicant)),
        'a handled task kept showing',
      ).toBe(false);
    }
    const history = (await feed(desk, 'view=history&limit=100')).items.find(
      (t) => t.id === deskTask?.id,
    );
    expect(history?.resolution).toMatchObject({ outcome: 'approved', byName: 'Tasks Master' });
  });

  it('claiming a KYC for review does NOT end the task — it is still waiting on a decision', async () => {
    const claimed = await client('north');
    const taskId = await seedTask(deskId, 'admin.kyc.submitted', kycOf(claimed));
    await ctx.db.db
      .update(kycSubmissions)
      .set({ status: 'under_review' })
      .where(eq(kycSubmissions.userId, claimed));
    const desk = await actingAs(ctx, 'admin', DESK);
    expect(ids(await feed(desk, 'view=inbox&limit=100'))).toContain(taskId);
  });
});

describe('opening is not handling — a task stays until somebody decides it (5 Oct 2026)', () => {
  it('reading marks it seen for the reader alone; it stays in the inbox and on the badge', async () => {
    const subject = await client('north');
    const deskTask = await seedTask(deskId, 'admin.kyc.submitted', kycOf(subject));
    const masterTask = await seedTask(masterId, 'admin.kyc.submitted', kycOf(subject));
    const desk = await actingAs(ctx, 'admin', DESK);
    const master = await actingAs(ctx, 'admin', MASTER);
    const before = await summary(desk);

    const read = await desk.post(`/v1/admin/notifications/${deskTask}/read`, {});
    expect(read.status).toBe(200);
    const row = (await feed(desk)).items.find((t) => t.id === deskTask);
    expect(row, 'reading took the task out of the inbox').toBeDefined();
    expect(row?.readAt).not.toBeNull();
    expect((await summary(desk)).count, 'reading lowered the badge').toBe(before.count);
    expect(
      ids(await feed(desk, 'view=history&limit=100')),
      'a task nobody handled was filed in history',
    ).not.toContain(deskTask);
    // Seen is personal: the other admin's copy still reads as new.
    expect((await feed(master)).items.find((t) => t.id === masterTask)?.readAt).toBeNull();
  });

  it('opening the item itself marks the reader’s tasks about it seen, and keeps them', async () => {
    const subject = await client('north');
    const taskId = await seedTask(deskId, 'admin.kyc.submitted', kycOf(subject));
    const desk = await actingAs(ctx, 'admin', DESK);
    const res = await desk.post('/v1/admin/notifications/read-subject', {
      subjectKind: 'kyc',
      subjectId: String(subject),
    });
    expect(res.status).toBe(200);
    expect((res.body as { updated: number }).updated).toBe(1);
    expect((await feed(desk)).items.find((t) => t.id === taskId)?.readAt).not.toBeNull();
  });
});

describe('a task whose item may stay as it is ends by a DECISION — the kept clawback', () => {
  /** A standing accrual for a clawback task to be about. */
  async function accrual(earner: number): Promise<string> {
    const { rows } = await ctx.db.db.execute<{ id: string }>(sql`
      INSERT INTO ib_accruals (ib_user_id, client_user_id, source_type, source_id, depth,
                               rate_value, base_amount, amount, currency)
      VALUES (${earner}, ${earner}, 'transaction', gen_random_uuid(), 1,
              '10.0000', '50.00000000', '5.00000000', 'USD')
      RETURNING id`);
    return rows[0].id;
  }
  const clawbackOf = (id: string, clientId: number) => ({
    kind: 'ib_accrual' as const,
    id,
    clientId,
  });
  const reason = { reason: 'Dealer re-opened the trade; the partner keeps it.' };

  it('"keep" ends it for EVERY admin, credits the decider, and is audited — once', async () => {
    const earner = await client('north');
    const accrualId = await accrual(earner);
    const masterTask = await seedTask(
      masterId,
      'admin.commission.clawback',
      clawbackOf(accrualId, earner),
    );
    const otherTask = await seedTask(
      maskedId,
      'admin.commission.clawback',
      clawbackOf(accrualId, earner),
    );
    const master = await actingAs(ctx, 'admin', MASTER);
    const other = await actingAs(ctx, 'admin', MASKED);
    expect(ids(await feed(other))).toContain(otherTask);

    const res = await master.post(`/v1/admin/notifications/${masterTask}/close`, reason);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ id: masterTask, outcome: 'kept' });

    expect(ids(await feed(master))).not.toContain(masterTask);
    expect(ids(await feed(other)), 'the decision did not reach every holder').not.toContain(
      otherTask,
    );
    const history = (await feed(other, 'view=history&limit=100')).items.find(
      (t) => t.id === otherTask,
    );
    expect(history?.resolution).toMatchObject({ outcome: 'kept', byName: 'Tasks Master' });

    const audited = await ctx.db.db
      .select()
      .from(auditLog)
      .where(
        and(eq(auditLog.action, 'notification.task_close'), eq(auditLog.subjectId, accrualId)),
      );
    expect(audited).toHaveLength(1);
    expect(audited[0].details).toMatchObject({ kind: 'admin.commission.clawback' });

    const again = await master.post(`/v1/admin/notifications/${masterTask}/close`, reason);
    expect(again.status).toBe(409);
  });

  it('cannot keep what was already reversed — the reversal ended it first', async () => {
    const earner = await client('north');
    const accrualId = await accrual(earner);
    const taskId = await seedTask(
      masterId,
      'admin.commission.clawback',
      clawbackOf(accrualId, earner),
    );
    await ctx.db.db.execute(
      sql`UPDATE ib_accruals SET status = 'reversed' WHERE id = ${accrualId}`,
    );
    const master = await actingAs(ctx, 'admin', MASTER);
    const res = await master.post(`/v1/admin/notifications/${taskId}/close`, reason);
    expect(res.status).toBe(409);
    const row = (await feed(master, 'view=history&limit=100')).items.find((t) => t.id === taskId);
    expect(row?.resolution?.outcome).toBe('reversed');
  });

  it('refuses a kind with no such decision, and a reader who cannot act on the kind', async () => {
    const subject = await client('north');
    const kycTask = await seedTask(deskId, 'admin.kyc.submitted', kycOf(subject));
    const desk = await actingAs(ctx, 'admin', DESK);
    const refused = await desk.post(`/v1/admin/notifications/${kycTask}/close`, reason);
    expect(refused.status).toBe(400);
    expect(ids(await feed(desk)), 'a refused close still ended the task').toContain(kycTask);

    // The desk holds no `ib.commissions.reverse`: its clawback row does not exist for it.
    const accrualId = await accrual(subject);
    const clawback = await seedTask(
      deskId,
      'admin.commission.clawback',
      clawbackOf(accrualId, subject),
    );
    expect((await desk.post(`/v1/admin/notifications/${clawback}/close`, reason)).status).toBe(404);
  });
});

describe('the task names its client the way the reader may see them', () => {
  it('a role hiding names gets the Portal ID alone — and is told which fields are hidden', async () => {
    const named = await client('north');
    const taskId = await seedTask(maskedId, 'admin.kyc.submitted', kycOf(named));
    const masked = await actingAs(ctx, 'admin', MASKED);
    const body = await feed(masked);
    const task = body.items.find((t) => t.id === taskId);

    expect(task?.client.portalId).toEqual(expect.any(Number));
    expect(task?.client).not.toHaveProperty('firstName');
    expect(task?.client).not.toHaveProperty('lastName');
    expect(body.maskedFields).toEqual(
      expect.arrayContaining(['client.firstName', 'client.lastName']),
    );

    // Control: the same client, unmasked, by name.
    const masterTask = await seedTask(masterId, 'admin.kyc.submitted', kycOf(named));
    const master = await actingAs(ctx, 'admin', MASTER);
    const plain = (await feed(master)).items.find((t) => t.id === masterTask);
    expect(plain?.client.firstName).toBe('Task');
  });
});

describe('the badge is the inbox, cut two ways', () => {
  it('the categories add up to the total', async () => {
    const desk = await actingAs(ctx, 'admin', DESK);
    const s = await summary(desk);
    const sum = Object.values(s.byCategory).reduce((a, b) => a + b, 0);
    expect(sum).toBe(s.count);
    expect(Object.keys(s.byCategory).sort()).toEqual([
      'deposits',
      'ib',
      'kyc',
      'transfers',
      'withdrawals',
    ]);
  });
});
