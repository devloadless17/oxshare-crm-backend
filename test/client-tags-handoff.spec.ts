import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { ALL_PERMISSIONS } from './support/all-permissions';
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
 * ANY TAG, ON ANY CLIENT YOU CAN SEE — and a question before a client leaves
 * your view (owner, 28 Sep 2026).
 *
 * The rule this replaces refused every tag outside the actor's own territory
 * and refused removing the last tag keeping a client in view. Together those
 * made it impossible for a desk to hand a client to another desk, or for an
 * admin who sees new clients to route one to the right team.
 *
 * What is pinned here:
 *   - a hand-off works, in two confirmed steps, and the client then belongs to
 *     the other desk and no longer to the actor;
 *   - an unconfirmed change that would hide the client is REFUSED AND NOT
 *     WRITTEN (409 TAG_CHANGE_LEAVES_SCOPE);
 *   - the "new clients" grant counts: removing a last tag returns the client to
 *     intake, which that admin still sees, so nothing is asked;
 *   - two concurrent removals cannot together hide a client unconfirmed — the
 *     per-client lock makes the second one see the first;
 *   - a client outside the actor's territory is still a 404, whatever the tag.
 */

const PASSWORD = 'admin-password-123';
const MASTER = { email: 'handoff-master@oxshare.com', password: PASSWORD };
/** Territory: desk A. No "new clients" grant. */
const DESK_A = { email: 'handoff-desk-a@oxshare.com', password: PASSWORD };
/** Territory: desk B. The desk clients are handed to. */
const DESK_B = { email: 'handoff-desk-b@oxshare.com', password: PASSWORD };
/** Territory: desk A, plus the "new clients" grant. */
const INTAKE = { email: 'handoff-intake@oxshare.com', password: PASSWORD };
/** Territory: desks A and C, no grant — for the concurrency case. */
const DESK_AC = { email: 'handoff-desk-ac@oxshare.com', password: PASSWORD };

const CLIENTS = '/v1/admin/clients';

interface ChangeBody {
  assignments: { id: string }[];
  stillVisible: boolean;
}

let ctx: HttpTestContext;
let deskA: string;
let deskB: string;
let deskC: string;
/** Tagged desk A — handed to desk B by DESK_A. */
let handoffClient: number;
/** No tags — routed to desk B by INTAKE. */
let newClient: number;
/** Tagged desk A — INTAKE removes it, returning the client to intake. */
let returningClient: number;
/** Tagged desks A and C — the concurrency case. */
let raceClient: number;
/** Tagged desk B only — outside DESK_A's territory. */
let deskBClient: number;

async function waitForRow(action: string, subjectId: number, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const rows = await ctx.db.db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.action, action), eq(auditLog.subjectId, String(subjectId))));
    if (rows.length > 0 || Date.now() >= deadline) return rows;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

async function tagIdsOf(clientId: number): Promise<string[]> {
  const rows = await ctx.db.db
    .select({ tagId: clientTagAssignments.tagId })
    .from(clientTagAssignments)
    .where(eq(clientTagAssignments.userId, clientId));
  return rows.map((row) => row.tagId).sort();
}

beforeAll(async () => {
  ctx = await startHttpTestApp();
  const db = ctx.db.db;
  const passwords = new PasswordService();
  const hash = await passwords.hash(PASSWORD);

  const tagRows = await db
    .insert(clientTags)
    .values([
      { slug: 'handoff-desk-a', label: 'Handoff Desk A' },
      { slug: 'handoff-desk-b', label: 'Handoff Desk B' },
      { slug: 'handoff-desk-c', label: 'Handoff Desk C' },
    ])
    .returning();
  [deskA, deskB, deskC] = tagRows.map((tag) => tag.id);

  const [masterRole] = await db
    .insert(roles)
    .values({ name: 'Handoff Master', permissions: ALL_PERMISSIONS })
    .returning();
  await db.insert(admins).values({
    email: MASTER.email,
    passwordHash: hash,
    name: 'Handoff Master',
    role: 'sub_admin',
    roleId: masterRole.id,
    permissions: [],
    status: 'active',
  });

  // Everything the routes need, so a failure below is about SCOPE, never about
  // a missing permission.
  const [deskRole] = await db
    .insert(roles)
    .values({ name: 'Handoff Desk', permissions: ['clients.view', 'clients.tag', 'tags.view'] })
    .returning();

  const scopedAdmin = async (
    who: { email: string },
    name: string,
    territory: string[],
    seesUntriaged: boolean,
  ) => {
    const [admin] = await db
      .insert(admins)
      .values({
        email: who.email,
        passwordHash: hash,
        name,
        role: 'sub_admin',
        roleId: deskRole.id,
        permissions: [],
        seesUntriaged,
        status: 'active',
      })
      .returning();
    await db
      .insert(adminClientTagScopes)
      .values(territory.map((tagId) => ({ adminId: admin.id, tagId, createdBy: admin.id })));
  };
  await scopedAdmin(DESK_A, 'Desk A', [deskA], false);
  await scopedAdmin(DESK_B, 'Desk B', [deskB], false);
  await scopedAdmin(INTAKE, 'Intake', [deskA], true);
  await scopedAdmin(DESK_AC, 'Desk AC', [deskA, deskC], false);

  const client = async (label: string, tags: string[]) => {
    const [row] = await db
      .insert(users)
      .values({
        email: `handoff-${label}@oxshare-e2e.test`,
        passwordHash: 'x',
        firstName: 'Handoff',
        lastName: label,
      })
      .returning();
    if (tags.length > 0) {
      await db
        .insert(clientTagAssignments)
        .values(tags.map((tagId) => ({ userId: row.id, tagId })));
    }
    return row.id;
  };
  handoffClient = await client('handoff', [deskA]);
  newClient = await client('new', []);
  returningClient = await client('returning', [deskA]);
  raceClient = await client('race', [deskA, deskC]);
  deskBClient = await client('deskb', [deskB]);
});

afterAll(async () => {
  await stopHttpTestApp(ctx);
});

describe('a desk hands a client to another desk', () => {
  it('adds the other desk’s tag — the client keeps ours, so nothing is asked', async () => {
    const deskAdmin = await actingAs(ctx, 'admin', DESK_A);
    const res = await deskAdmin.post(`${CLIENTS}/${handoffClient}/tags/${deskB}`).expect(201);

    const body = res.body as ChangeBody;
    expect(body.stillVisible).toBe(true);
    expect(body.assignments.map((t) => t.id).sort()).toEqual([deskA, deskB].sort());
  });

  it('asks before removing our own tag — refused AND NOT WRITTEN until confirmed', async () => {
    const deskAdmin = await actingAs(ctx, 'admin', DESK_A);
    const res = await deskAdmin.del(`${CLIENTS}/${handoffClient}/tags/${deskA}`);

    expect(res.status).toBe(409);
    expect((res.body as { code?: string }).code).toBe('TAG_CHANGE_LEAVES_SCOPE');
    expect(await tagIdsOf(handoffClient), 'a refused change was written anyway').toEqual(
      [deskA, deskB].sort(),
    );
  });

  it('confirmed, the client moves: nothing more is returned about them', async () => {
    const deskAdmin = await actingAs(ctx, 'admin', DESK_A);
    const res = await deskAdmin
      .del(`${CLIENTS}/${handoffClient}/tags/${deskA}?confirmLeavesScope=true`)
      .expect(200);

    const body = res.body as ChangeBody;
    expect(body.stillVisible).toBe(false);
    expect(body.assignments, 'tags of a client the reader no longer sees').toEqual([]);
    expect(await tagIdsOf(handoffClient)).toEqual([deskB]);
  });

  it('the client now belongs to desk B, and is a 404 to desk A like any stranger', async () => {
    const deskAdmin = await actingAs(ctx, 'admin', DESK_A);
    const res = await deskAdmin.get(`${CLIENTS}/${handoffClient}`);
    expect(res.status).toBe(404);
    expect(res.status).not.toBe(403);

    const deskBAdmin = await actingAs(ctx, 'admin', DESK_B);
    await deskBAdmin.get(`${CLIENTS}/${handoffClient}`).expect(200);
  });

  it('the trail says the actor handed the client over', async () => {
    const rows = await waitForRow('client_tag.unassign', handoffClient);
    expect(rows).toHaveLength(1);
    expect(rows[0].details).toMatchObject({ tagId: deskA, leftActorScope: true });
  });
});

describe('an admin who sees new clients', () => {
  it('routes a new client to another desk — asked first, then moved', async () => {
    const intake = await actingAs(ctx, 'admin', INTAKE);
    // Visible to them through the grant: it carries no tags at all.
    await intake.get(`${CLIENTS}/${newClient}`).expect(200);

    const asked = await intake.post(`${CLIENTS}/${newClient}/tags/${deskB}`);
    expect(asked.status).toBe(409);
    expect((asked.body as { code?: string }).code).toBe('TAG_CHANGE_LEAVES_SCOPE');
    expect(await tagIdsOf(newClient)).toEqual([]);

    const moved = await intake
      .post(`${CLIENTS}/${newClient}/tags/${deskB}?confirmLeavesScope=true`)
      .expect(201);
    expect((moved.body as ChangeBody).stillVisible).toBe(false);

    expect((await intake.get(`${CLIENTS}/${newClient}`)).status).toBe(404);
    const deskBAdmin = await actingAs(ctx, 'admin', DESK_B);
    await deskBAdmin.get(`${CLIENTS}/${newClient}`).expect(200);
  });

  it('is NOT asked when removing a last tag: the client returns to new, which they see', async () => {
    /*
     * The old refusal ("the only tag putting this client in your view")
     * ignored the grant and refused this outright, although nothing left the
     * actor's view.
     */
    const intake = await actingAs(ctx, 'admin', INTAKE);
    const res = await intake.del(`${CLIENTS}/${returningClient}/tags/${deskA}`).expect(200);

    const body = res.body as ChangeBody;
    expect(body.stillVisible).toBe(true);
    expect(body.assignments).toEqual([]);
    await intake.get(`${CLIENTS}/${returningClient}`).expect(200);
  });
});

describe('the confirmation is judged on the tags as they really are', () => {
  it('two concurrent removals cannot together hide a client unconfirmed', async () => {
    /*
     * Each removal alone leaves the client in view (it keeps the other tag).
     * Without the per-client lock both read the pair, both pass, and the client
     * silently leaves the actor's view with nobody having confirmed it. With it,
     * the second sees the first's result and is asked.
     */
    const admin = await actingAs(ctx, 'admin', DESK_AC);
    const [first, second] = await Promise.all([
      admin.del(`${CLIENTS}/${raceClient}/tags/${deskA}`),
      admin.del(`${CLIENTS}/${raceClient}/tags/${deskC}`),
    ]);

    expect([first.status, second.status].sort()).toEqual([200, 409]);
    expect(await tagIdsOf(raceClient), 'both removals were written').toHaveLength(1);
  });

  it('refuses a confirmation value other than "true" rather than guessing', async () => {
    const deskAdmin = await actingAs(ctx, 'admin', DESK_A);
    const res = await deskAdmin.post(
      `${CLIENTS}/${returningClient}/tags/${deskB}?confirmLeavesScope=yes`,
    );
    expect(res.status).toBe(400);
  });

  it('a client outside the actor’s territory is a 404 whatever the tag — never a 409', async () => {
    // A 409 here would confirm the client exists: the enumeration oracle the
    // 404-not-403 rule exists to refuse.
    const deskAdmin = await actingAs(ctx, 'admin', DESK_A);
    const res = await deskAdmin.post(
      `${CLIENTS}/${deskBClient}/tags/${deskA}?confirmLeavesScope=true`,
    );
    expect(res.status).toBe(404);
    expect(await tagIdsOf(deskBClient)).toEqual([deskB]);
  });

  it('an unrestricted admin is never asked', async () => {
    const master = await actingAs(ctx, 'admin', MASTER);
    const res = await master.del(`${CLIENTS}/${deskBClient}/tags/${deskB}`).expect(200);
    expect((res.body as ChangeBody).stillVisible).toBe(true);
  });
});
