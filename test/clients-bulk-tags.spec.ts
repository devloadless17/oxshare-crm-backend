import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { actingAs, startHttpTestApp, stopHttpTestApp, type HttpTestContext } from './http-setup';
import { PasswordService } from '../src/common/security/password.service';
import {
  adminClientTagScopes,
  admins,
  auditLog,
  clientTagAssignments,
  clientTags,
  roles,
  users,
} from '../src/database/schema';

/**
 * BULK TAGGING — many clients in one step (Slice 3, 6 Oct 2026).
 *
 * Every rule of a single tag change, decided once for the whole set:
 *   - picked clients outside the actor's territory are SKIPPED and counted,
 *     never touched;
 *   - "all matching" carries the count the reader saw; a moved count is 409
 *     BULK_TARGET_CHANGED with the new number, and nothing changes;
 *   - moving clients out of the actor's view needs the confirmation (409 with
 *     how many), then hands them over;
 *   - a country tag is refused;
 *   - one bulk audit row plus one per real change, all carrying the bulkId;
 *   - a replayed request (same Idempotency-Key) changes nothing twice.
 */

let ctx: HttpTestContext;
const PASSWORD = 'admin-password-123';
const DESK = { email: 'bulk-desk@oxshare.com', password: PASSWORD };
const BULK = '/v1/admin/clients/bulk/tags';

let mine: string;
let theirs: string;
let label: string;
let deskId: string;
const ours: number[] = [];
let foreign: number;

async function chosenTags(id: number) {
  const rows = await ctx.db.db
    .select({ tagId: clientTagAssignments.tagId })
    .from(clientTagAssignments)
    .where(eq(clientTagAssignments.userId, id));
  return rows.map((r) => r.tagId).sort();
}

beforeAll(async () => {
  ctx = await startHttpTestApp();
  const db = ctx.db.db;
  const hash = await new PasswordService().hash(PASSWORD);
  [mine, theirs, label] = (
    await db
      .insert(clientTags)
      .values([
        { slug: 'bulk-mine', label: 'Bulk Mine' },
        { slug: 'bulk-theirs', label: 'Bulk Theirs' },
        { slug: 'bulk-label', label: 'Bulk Label' },
      ])
      .returning()
  ).map((t) => t.id);

  const [role] = await db
    .insert(roles)
    .values({ name: 'Bulk Desk', permissions: ['clients.view', 'clients.tag', 'clients.bulk'] })
    .returning();
  const [desk] = await db
    .insert(admins)
    .values({
      email: DESK.email,
      passwordHash: hash,
      name: 'Bulk Desk',
      role: 'sub_admin',
      roleId: role.id,
      permissions: [],
      seesAllClients: false,
      status: 'active',
    })
    .returning();
  deskId = desk.id;
  await db
    .insert(adminClientTagScopes)
    .values({ adminId: desk.id, tagId: mine, createdBy: desk.id });

  for (let i = 0; i < 3; i++) {
    const [row] = await db
      .insert(users)
      .values({
        email: `bulk-ours-${i}@oxshare-e2e.test`,
        passwordHash: 'x',
        firstName: 'Bulk',
        lastName: `Ours${i}`,
      })
      .returning();
    ours.push(row.id);
  }
  await db.insert(clientTagAssignments).values(ours.map((userId) => ({ userId, tagId: mine })));
  const [other] = await db
    .insert(users)
    .values({
      email: 'bulk-foreign@oxshare-e2e.test',
      passwordHash: 'x',
      firstName: 'Bulk',
      lastName: 'Foreign',
    })
    .returning();
  foreign = other.id;
  await db.insert(clientTagAssignments).values({ userId: foreign, tagId: theirs });
}, 180_000);

afterAll(async () => {
  await stopHttpTestApp(ctx);
});

describe('picked clients', () => {
  it('skips and counts a picked client outside the territory, never touching them', async () => {
    const desk = await actingAs(ctx, 'admin', DESK);
    const res = await desk
      .post(BULK)
      .set('Idempotency-Key', randomUUID())
      .send({ target: { ids: [...ours, foreign] }, add: [label] });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body).toEqual({ matched: 3, changed: 3, unchanged: 0, skippedOutOfScope: 1 });
    expect(await chosenTags(foreign)).toEqual([theirs]);
    for (const id of ours) expect(await chosenTags(id)).toContain(label);
  });

  it('a second identical change changes nothing', async () => {
    const desk = await actingAs(ctx, 'admin', DESK);
    const res = await desk
      .post(BULK)
      .set('Idempotency-Key', randomUUID())
      .send({ target: { ids: ours }, add: [label] })
      .expect(201);
    expect(res.body).toMatchObject({ matched: 3, changed: 0, unchanged: 3 });
  });

  it('refuses a country tag', async () => {
    const [lebanon] = await ctx.db.db
      .select({ id: clientTags.id })
      .from(clientTags)
      .where(eq(clientTags.countryCode, 'LB'));
    const desk = await actingAs(ctx, 'admin', DESK);
    const res = await desk
      .post(BULK)
      .set('Idempotency-Key', randomUUID())
      .send({ target: { ids: ours }, add: [lebanon.id] });
    expect(res.status).toBe(400);
  });
});

describe('all matching a filter', () => {
  it('refuses when the count moved, saying the new one — and changes nothing', async () => {
    const desk = await actingAs(ctx, 'admin', DESK);
    const res = await desk
      .post(BULK)
      .set('Idempotency-Key', randomUUID())
      .send({ target: { filter: { tag: 'bulk-mine' }, expectedCount: 99 }, remove: [label] });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('BULK_TARGET_CHANGED');
    expect(res.body.fields?.count).toBe('3');
    for (const id of ours) expect(await chosenTags(id)).toContain(label);
  });
});

describe('moving a book to another desk', () => {
  it('asks first with how many leave, then hands them over and records it', async () => {
    const desk = await actingAs(ctx, 'admin', DESK);
    const move = {
      target: { filter: { tag: 'bulk-mine' }, expectedCount: 3 },
      add: [theirs],
      remove: [mine],
    };
    const asked = await desk.post(BULK).set('Idempotency-Key', randomUUID()).send(move);
    expect(asked.status).toBe(409);
    expect(asked.body.code).toBe('TAG_CHANGE_LEAVES_SCOPE');
    expect(asked.body.fields?.count).toBe('3');
    for (const id of ours) expect(await chosenTags(id)).toContain(mine);

    const moved = await desk
      .post(BULK)
      .set('Idempotency-Key', 'bulk-move-1')
      .send({ ...move, confirmLeavesScope: true })
      .expect(201);
    expect(moved.body).toMatchObject({ matched: 3, changed: 3 });
    for (const id of ours) {
      expect(await chosenTags(id)).not.toContain(mine);
      expect(await chosenTags(id)).toContain(theirs);
    }

    // One bulk row, and per-client rows carrying its bulkId.
    const [bulkRow] = await ctx.db.db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.action, 'client_tag.bulk'), eq(auditLog.actorId, deskId)))
      .orderBy(sql`${auditLog.createdAt} DESC`)
      .limit(1);
    const bulkId = (bulkRow.details as { bulkId: string }).bulkId;
    const perClient = await ctx.db.db
      .select()
      .from(auditLog)
      .where(
        and(
          inArray(auditLog.action, ['client_tag.assign', 'client_tag.unassign']),
          sql`${auditLog.details}->>'bulkId' = ${bulkId}`,
        ),
      );
    expect(perClient).toHaveLength(6);

    // A replay of the same request is answered from the record, not re-run.
    const replay = await desk
      .post(BULK)
      .set('Idempotency-Key', 'bulk-move-1')
      .send({ ...move, confirmLeavesScope: true });
    expect(replay.body).toEqual(moved.body);
  });
});
