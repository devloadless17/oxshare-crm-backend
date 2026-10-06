import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ALL_PERMISSIONS } from './support/all-permissions';
import { actingAs, startHttpTestApp, stopHttpTestApp, type HttpTestContext } from './http-setup';
import { PasswordService } from '../src/common/security/password.service';
import {
  adminClientTagScopes,
  admins,
  clientTagAssignments,
  clientTags,
  roles,
  users,
} from '../src/database/schema';

/**
 * EVERY CLIENT IS AN EXPLICIT GRANT — AN EMPTY TERRITORY NO LONGER MEANS EVERYONE (0154).
 *
 * The fail-open this closes: clearing a scoped admin's last territory tag
 * silently promoted them to every client in the system, because "no scope
 * rows" was how UNRESTRICTED was spelled. The widest sight came from an
 * absence, with nothing in the request that looked like a grant.
 */

const PASSWORD = 'admin-password-123';
const MASTER = { email: 'allclients-master@oxshare.com', password: PASSWORD };
const DESK = { email: 'allclients-desk@oxshare.com', password: PASSWORD };
/** Scoped, and may edit other admins' visibility — but does not see every client. */
const SCOPED_MANAGER = { email: 'allclients-manager@oxshare.com', password: PASSWORD };

let ctx: HttpTestContext;
let deskId: string;

beforeAll(async () => {
  ctx = await startHttpTestApp();
  const db = ctx.db.db;
  const hash = await new PasswordService().hash(PASSWORD);

  const [tag] = await db
    .insert(clientTags)
    .values({ slug: 'allclients-desk', label: 'AllClients Desk' })
    .returning();

  const [masterRole] = await db
    .insert(roles)
    .values({ name: 'AllClients Master', permissions: ALL_PERMISSIONS })
    .returning();
  await db.insert(admins).values({
    email: MASTER.email,
    passwordHash: hash,
    name: 'AllClients Master',
    role: 'sub_admin',
    roleId: masterRole.id,
    permissions: [],
    seesAllClients: true,
    status: 'active',
  });

  const [deskRole] = await db
    .insert(roles)
    .values({ name: 'AllClients Desk', permissions: ['clients.view'] })
    .returning();
  const [desk] = await db
    .insert(admins)
    .values({
      email: DESK.email,
      passwordHash: hash,
      name: 'AllClients Desk',
      role: 'sub_admin',
      roleId: deskRole.id,
      permissions: [],
      seesAllClients: false,
      status: 'active',
    })
    .returning();
  deskId = desk.id;
  await db
    .insert(adminClientTagScopes)
    .values({ adminId: desk.id, tagId: tag.id, createdBy: desk.id });

  const [managerRole] = await db
    .insert(roles)
    .values({
      name: 'AllClients Manager',
      permissions: ['admins.view', 'admins.edit', 'admins.scope'],
    })
    .returning();
  const [manager] = await db
    .insert(admins)
    .values({
      email: SCOPED_MANAGER.email,
      passwordHash: hash,
      name: 'AllClients Manager',
      role: 'sub_admin',
      roleId: managerRole.id,
      permissions: [],
      seesAllClients: false,
      status: 'active',
    })
    .returning();
  await db
    .insert(adminClientTagScopes)
    .values({ adminId: manager.id, tagId: tag.id, createdBy: manager.id });

  // One client in the desk's territory, and one carrying no tags at all.
  const [inDesk] = await db
    .insert(users)
    .values({
      email: 'allclients-in@oxshare-e2e.test',
      passwordHash: 'x',
      firstName: 'In',
      lastName: 'Desk',
    })
    .returning();
  await db.insert(clientTagAssignments).values({ userId: inDesk.id, tagId: tag.id });
  await db.insert(users).values({
    email: 'allclients-new@oxshare-e2e.test',
    passwordHash: 'x',
    firstName: 'New',
    lastName: 'Client',
  });
});

afterAll(async () => {
  await stopHttpTestApp(ctx);
});

async function emailsSeenBy(who: { email: string; password: string }): Promise<string[]> {
  const session = await actingAs(ctx, 'admin', who);
  const res = await session.get('/v1/admin/clients?q=allclients-&limit=50').expect(200);
  return (res.body as { items: { email?: string }[] }).items.map((c) => c.email ?? '');
}

describe('an empty territory is NOT every client', () => {
  it('clearing a scoped admin’s last tag leaves them seeing no one — never everyone', async () => {
    expect(await emailsSeenBy(DESK)).toEqual(['allclients-in@oxshare-e2e.test']);

    const master = await actingAs(ctx, 'admin', MASTER);
    await master.patch(`/v1/admin/users/${deskId}`, { scopedTagIds: [] }).expect(200);

    expect(
      await emailsSeenBy(DESK),
      'an emptied territory widened the admin to every client — the fail-open 0154 closes',
    ).toEqual([]);
  });

  it('every client is the explicit grant — and only from an admin who has it', async () => {
    const manager = await actingAs(ctx, 'admin', SCOPED_MANAGER);
    const refused = await manager.patch(`/v1/admin/users/${deskId}`, { seesAllClients: true });
    expect(refused.status, 'a scoped admin handed out sight of every client').toBe(403);

    const master = await actingAs(ctx, 'admin', MASTER);
    await master.patch(`/v1/admin/users/${deskId}`, { seesAllClients: true }).expect(200);
    expect(await emailsSeenBy(DESK)).toEqual(
      expect.arrayContaining(['allclients-in@oxshare-e2e.test', 'allclients-new@oxshare-e2e.test']),
    );
  });
});
