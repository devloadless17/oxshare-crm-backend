import { ALL_PERMISSIONS } from './support/all-permissions';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, desc, eq } from 'drizzle-orm';
import { actingAs, startHttpTestApp, stopHttpTestApp, type HttpTestContext } from './http-setup';
import { PasswordService } from '../src/common/security/password.service';
import { admins, auditLog, clientTags, roles } from '../src/database/schema';

/**
 * A permission refusal decided INSIDE a service leaves an audit row.
 *
 * ## The gap
 *
 * `PermissionsGuard` records `security.denied` when it refuses, and it is the
 * only writer of that action in the codebase. Around eighty
 * `assertActorCan` / `assertActorCanAny` call sites refuse inside services, and
 * every one of them produced a 403 with no record whatever.
 *
 * That is not a uniform blind spot — it lands exactly where guard and service
 * DELIBERATELY differ, which is where the interesting refusals are. This file
 * drives the clearest instance: `PATCH /admin/users/:id` is guarded on
 * `admins.edit`, and changing an administrator's TERRITORY additionally requires
 * `admins.scope`, asserted in `AdminRbacService.updateAdmin`. An administrator
 * who holds the first and not the second is refused by the service — an attempt
 * to widen somebody's client visibility, which is about as close to an attempted
 * privilege escalation as this system has — and it recorded nothing.
 *
 * ## Why the two rows must stay distinguishable
 *
 * `reason` separates them. "Refused at the door" and "refused after the handler
 * began deciding" are different events, and an investigation reading a trail
 * that collapsed them could not tell an operator who clicked something they
 * never had from one who got far enough for the service to weigh it.
 */

const MASTER = { email: 'denial-master@oxshare.com', password: 'admin-password-123' };
/** Holds `admins.edit` and NOT `admins.scope` — the service refuses them. */
const EDITOR = { email: 'denial-editor@oxshare.com', password: 'admin-password-123' };
/** Holds neither — the GUARD refuses them, for the contrast. */
const OUTSIDER = { email: 'denial-outsider@oxshare.com', password: 'admin-password-123' };

let ctx: HttpTestContext;
let targetId: string;
let tagId: string;

/**
 * The audit subject, as both writers spell it.
 *
 * `req.path` VERBATIM, `/v1` and all — which is what `PermissionsGuard` has
 * always recorded and what the interceptor matches deliberately. Anything that
 * DECIDES from a path must strip the prefix (`stripApiPrefix`); this only
 * labels a row, and two writers spelling one route differently would split an
 * investigation's search in half.
 */
const subject = () => `PATCH /v1/admin/users/${targetId}`;

const rowsFor = async (action: string, subjectId: string) =>
  ctx.db.db
    .select()
    .from(auditLog)
    .where(and(eq(auditLog.action, action), eq(auditLog.subjectId, subjectId)))
    .orderBy(desc(auditLog.createdAt));

/**
 * Wait for a FIRE-AND-FORGET audit write to land.
 *
 * `AdminAuditService.record` deliberately does not await — "an audit-write
 * failure must never fail the admin action" — so the row is in flight when the
 * response returns, and a query issued immediately finds nothing. Reading once
 * and asserting zero would report this feature as broken on a fast machine and
 * working on a slow one.
 *
 * Polls rather than sleeps a fixed interval, so the common case costs one query
 * and the assertion still fails (rather than hangs) if the write never happens.
 */
async function eventually<T>(read: () => Promise<T[]>, timeoutMs = 3_000): Promise<T[]> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const rows = await read();
    if (rows.length > 0 || Date.now() > deadline) return rows;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

beforeAll(async () => {
  ctx = await startHttpTestApp();
  const db = ctx.db.db;
  const passwords = new PasswordService();
  const hash = await passwords.hash(MASTER.password);

  const [masterRole] = await db
    .insert(roles)
    .values({ name: 'Denial Master', permissions: ALL_PERMISSIONS, isSystem: true })
    .returning();
  const [editorRole] = await db
    .insert(roles)
    .values({
      name: 'Denial Editor',
      // `admins.edit` opens the route; `admins.scope` is what the service wants
      // and is deliberately absent.
      permissions: ['admins.view', 'admins.edit'],
    })
    .returning();
  const [outsiderRole] = await db
    .insert(roles)
    .values({ name: 'Denial Outsider', permissions: ['admins.view'] })
    .returning();

  const inserted = await db
    .insert(admins)
    .values([
      {
        email: MASTER.email,
        passwordHash: hash,
        name: 'Denial Master',
        role: 'master_admin',
        roleId: masterRole.id,
        permissions: ALL_PERMISSIONS,
      },
      {
        email: EDITOR.email,
        passwordHash: hash,
        name: 'Denial Editor',
        role: 'sub_admin',
        roleId: editorRole.id,
        permissions: [],
      },
      {
        email: OUTSIDER.email,
        passwordHash: hash,
        name: 'Denial Outsider',
        role: 'sub_admin',
        roleId: outsiderRole.id,
        permissions: [],
      },
    ])
    .returning();
  // The subject of the edit: the outsider, who is nobody's manager.
  targetId = inserted[2].id;

  const [tag] = await db
    .insert(clientTags)
    .values({ slug: 'denial-territory', label: 'Denial Territory' })
    .returning();
  tagId = tag.id;
}, 180_000);

afterAll(async () => {
  await stopHttpTestApp(ctx);
});

describe('a refusal decided in a SERVICE is recorded', () => {
  it('writes security.denied when admins.scope is missing, though the guard admitted', async () => {
    const editor = await actingAs(ctx, 'admin', EDITOR);

    const res = await editor.patch(`/v1/admin/users/${targetId}`, { scopedTagIds: [tagId] });

    // The guard let them in on `admins.edit`; the service refused on
    // `admins.scope`. Without that split this test would prove nothing.
    expect(res.status, 'the service did not refuse — the fixture no longer models the gap').toBe(
      403,
    );

    const rows = await eventually(() => rowsFor('security.denied', subject()));
    expect(rows.length, 'the service refusal left no audit row').toBeGreaterThan(0);

    const details = rows[0].details as { reason?: string } | null;
    expect(details?.reason).toBe('service');
  });

  it('still records the GUARD’s refusals, with a reason that tells them apart', async () => {
    /*
     * The control, and the reason `reason` exists. If the interceptor ever
     * started catching what the guard throws, both refusals would land as
     * 'service' and the trail would stop distinguishing "never had the key" from
     * "got far enough to be weighed".
     */
    const outsider = await actingAs(ctx, 'admin', OUTSIDER);

    const res = await outsider.patch(`/v1/admin/users/${targetId}`, { name: 'Renamed' });
    expect(res.status).toBe(403);

    /*
     * Polls for the GUARD's row specifically, not for "any row".
     *
     * The first draft waited for `security.denied` on this subject and then
     * filtered — and the service row from the case above already satisfied that,
     * so it returned immediately with the wrong row and reported the guard as
     * silent. The guard was writing all along. A poll whose predicate is looser
     * than its assertion is a race that resolves to the wrong answer.
     */
    const guardRows = await eventually(() =>
      rowsFor('security.denied', subject()).then((all) =>
        all.filter((row) => (row.details as { reason?: string } | null)?.reason === 'permission'),
      ),
    );

    expect(guardRows.length, 'the guard refusal left no audit row').toBeGreaterThan(0);
    expect((guardRows[0].details as { required?: string[] }).required).toContain('admins.edit');
  });

  it('records nothing for a request that SUCCEEDS', async () => {
    // A denial log that also logs successes is a log nobody reads.
    const master = await actingAs(ctx, 'admin', MASTER);
    const before = (await rowsFor('security.denied', subject())).length;

    await master.patch(`/v1/admin/users/${targetId}`, { name: 'Renamed By Master' }).expect(200);

    const after = (await rowsFor('security.denied', subject())).length;
    expect(after).toBe(before);
  });
});
