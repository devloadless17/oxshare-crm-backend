import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { actingAs, startHttpTestApp, stopHttpTestApp, type HttpTestContext } from './http-setup';
import { PasswordService } from '../src/common/security/password.service';
import { admins, roles } from '../src/database/schema';

/**
 * THE ROLE-EDIT DOOR INTO "NOBODY MAY LEAVE THE SYSTEM UNMANAGEABLE".
 *
 * `assertNotLastManager` refuses any write that would leave no active
 * administrator holding `roles.edit`. It is reachable through three doors —
 * suspending the last holder, moving them to a lesser role, and unticking the
 * key on the last role that carries it — and only the first was ever proven.
 *
 * ## Why this is here and not in the browser suite
 *
 * `roles-lifecycle.spec.ts` has a case for exactly this. It has NEVER RUN, in
 * any environment, and its own docblock explains why: deciding it requires a
 * database where exactly ONE role carries `roles.edit` with an active holder.
 *
 *   - a fresh CI database seeds three roles carrying it (Administrator, Master
 *     Admin, E2E Admin all hold ALL_PERMISSIONS)
 *   - a shared dev database is worse: `permissions-deep.spec.ts` mints a
 *     manager role every run and never deletes it — 54 had accumulated
 *
 * Reaching the state on a shared database would mean suspending every other
 * holder, which is a lockout risk and not something a test may do to the
 * environment it runs in. So the guards fired, the case skipped, and a skipped
 * Playwright test reports as PASSING.
 *
 * The answer is to give it a database it owns, and this suite already has one:
 * Testcontainers starts a real Postgres per run and `startHttpTestApp`
 * deliberately does NOT run the seeds, so a suite states the identities it
 * needs. The case is pure HTTP — `PUT /admin/roles/:id` answering 400 — and was
 * only ever in the browser suite by proximity to the roles screen, so nothing
 * about it wanted a browser.
 *
 * ## The key this door can actually reach is `admins.edit`, NOT `roles.edit`
 *
 * Worth stating, because the browser spec assumed the opposite and it explains
 * why no amount of database shaping would have made it pass.
 *
 * `assertKeepsAManager` guards TWO keys. For the write to be refused, NOBODY may
 * hold the key afterwards — including the actor. But to edit a role at all the
 * actor must hold `roles.edit` (PermissionsGuard), and an admin editing their
 * OWN role is refused flatly and earlier. So on the `roles.edit` key the actor
 * is necessarily a surviving holder, and the refusal CANNOT fire through this
 * door. It is unreachable by construction, not by database state.
 *
 * `admins.edit` is different, and that difference is the whole reason this file
 * can exist: editing a role does not require holding `admins.edit`. So an actor
 * with `roles.edit` and without `admins.edit` can strip `admins.edit` from the
 * last role carrying it and leave nobody able to manage administrators — which
 * is exactly the lockout the invariant exists to prevent, through the one door
 * that was never proven.
 *
 * A `master_admin` carrying `['*']` cannot stand in for the actor: the wildcard
 * is NOT expanded by PermissionsGuard, which answers "Missing permission: this
 * action requires roles.edit." Verified, not assumed.
 */

const SOLE_MANAGER = 'Sole Admin Manager';
/** Holds `roles.edit` so it may edit roles, and NOT `admins.edit` so it is not a holder. */
const ACTOR = { email: 'last-manager-actor@oxshare.com', password: 'admin-password-123' };
const HOLDER = { email: 'last-manager-holder@oxshare.com', password: 'admin-password-123' };
const ACTOR_PERMISSIONS = ['roles.edit', 'roles.view', 'admins.view'];

let ctx: HttpTestContext;

/** The permissions a role currently carries, read through the list endpoint. */
async function permissionsOf(
  session: Awaited<ReturnType<typeof actingAs>>,
  roleId: string,
): Promise<string[]> {
  const res = await session.get('/v1/admin/roles');
  expect(res.status).toBe(200);
  const found = (res.body as { id: string; permissions: string[] }[]).find((r) => r.id === roleId);
  expect(found, `role ${roleId} is not in the list`).toBeDefined();
  return found!.permissions;
}

/**
 * Take `admins.edit` away from every role and admin EXCEPT the actor.
 *
 * These cases share one app and one database, so without this each test
 * inherits the manager roles the previous one created — and a case asserting
 * "this is the LAST holder" would silently be asserting nothing, because two
 * earlier roles still carry the key. That is the same class of false green this
 * whole file exists to remove, so it is done explicitly rather than by ordering.
 */
async function clearOtherManagers(): Promise<void> {
  const db = ctx.db.db;
  await db.update(roles).set({ permissions: ['admins.view'] });
  await db
    .update(admins)
    .set({ permissions: ACTOR_PERMISSIONS })
    .where(eq(admins.email, ACTOR.email));
}

/** A role carrying `admins.edit`, plus one ACTIVE admin standing on it. */
async function manageableRole(name: string, holderEmail: string): Promise<string> {
  const db = ctx.db.db;
  const passwords = new PasswordService();

  const [role] = await db
    .insert(roles)
    .values({ name, permissions: ['admins.edit', 'admins.view'] })
    .returning();

  await db.insert(admins).values({
    email: holderEmail,
    passwordHash: await passwords.hash(HOLDER.password),
    name: `Holder of ${name}`,
    role: 'sub_admin',
    roleId: role.id,
    permissions: [],
    status: 'active',
  });

  return role.id;
}

beforeAll(async () => {
  ctx = await startHttpTestApp();
  const db = ctx.db.db;
  const passwords = new PasswordService();

  /*
   * The actor holds `roles.edit` (so it may edit a role) and deliberately NOT
   * `admins.edit` (so stripping that key leaves nobody holding it). Giving it
   * `admins.edit` would make it a surviving holder and the refusal could never
   * fire — this file would pass without reaching the guard.
   *
   * `role: 'sub_admin'` with an explicit list rather than a master with ['*']:
   * the wildcard is not expanded by PermissionsGuard.
   */
  await db.insert(admins).values({
    email: ACTOR.email,
    passwordHash: await passwords.hash(ACTOR.password),
    name: 'Last Manager Actor',
    role: 'sub_admin',
    permissions: ACTOR_PERMISSIONS,
    status: 'active',
  });
}, 120_000);

afterAll(async () => {
  await stopHttpTestApp(ctx);
});

describe('unticking admins.edit on the last role that carries it', () => {
  it('is REFUSED when that role is the only way anyone holds it', async () => {
    await clearOtherManagers();
    const roleId = await manageableRole(SOLE_MANAGER, HOLDER.email);
    const master = await actingAs(ctx, 'admin', ACTOR);

    const refused = await master
      .put(`/v1/admin/roles/${roleId}`)
      .send({ permissions: ['admins.view'] });

    expect(
      refused.status,
      `stripping admins.edit from the only role carrying it answered ${refused.status}. ` +
        'The system would have been left with no administrator able to manage administrators.',
    ).toBe(400);
    expect(JSON.stringify(refused.body)).toMatch(/admins\.edit/);

    // Non-vacuous: the role still carries the key, so the refusal REFUSED
    // rather than merely reporting an error after writing.
    expect(
      await permissionsOf(master, roleId),
      'the refusal did not refuse — the key is gone',
    ).toContain('admins.edit');
  });

  it('is ALLOWED when a second role still carries it — the control', async () => {
    /*
     * Without this the refusal above could be a role editor that rejects every
     * permission change, which would pass the assertion and break the screen.
     */
    await clearOtherManagers();
    const first = await manageableRole('Manager A', 'last-manager-a@oxshare.com');
    await manageableRole('Manager B', 'last-manager-b@oxshare.com');
    const master = await actingAs(ctx, 'admin', ACTOR);

    const allowed = await master
      .put(`/v1/admin/roles/${first}`)
      .send({ permissions: ['admins.view'] });

    expect(
      allowed.status,
      `stripping admins.edit answered ${allowed.status} while ANOTHER role still carries it — ` +
        'the guard is refusing more than the invariant asks for.',
    ).toBe(200);

    expect(await permissionsOf(master, first)).not.toContain('admins.edit');
  });

  it('counts only ACTIVE holders, so a suspended one does not keep the system manageable', async () => {
    /*
     * The half a naive implementation gets wrong: "somebody is on a role that
     * carries roles.edit" is not the same as "somebody can still use it". A
     * suspended administrator cannot sign in, so a role whose only holder is
     * suspended keeps nobody managing anything.
     */
    await clearOtherManagers();
    const db = ctx.db.db;
    const roleId = await manageableRole('Manager C', 'last-manager-c@oxshare.com');
    const dormant = await manageableRole('Manager D', 'last-manager-d@oxshare.com');
    await db
      .update(admins)
      .set({ status: 'suspended' })
      .where(eq(admins.email, 'last-manager-d@oxshare.com'));

    const master = await actingAs(ctx, 'admin', ACTOR);
    const refused = await master
      .put(`/v1/admin/roles/${roleId}`)
      .send({ permissions: ['admins.view'] });

    expect(
      refused.status,
      'the only OTHER holder is suspended, so this write leaves nobody managing administrators',
    ).toBe(400);
    void dormant;
  });
});
