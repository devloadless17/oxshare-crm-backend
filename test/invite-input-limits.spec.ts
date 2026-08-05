import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  actingAs,
  anonymous,
  startHttpTestApp,
  stopHttpTestApp,
  SURFACES,
  type HttpTestContext,
} from './http-setup';
import { PasswordService } from '../src/common/security/password.service';
import { admins, roles } from '../src/database/schema';

/**
 * Input bounds on the admin invite surface.
 *
 * The portal's DTOs cap what they accept — `MaxLength(50)` on names,
 * `MaxLength(100)` on passwords. The admin auth DTOs were written separately and
 * capped nothing, so the same decisions had two different answers depending on
 * which door you came through.
 *
 * Two consequences, and neither is theoretical:
 *
 *  - `admin_invites.name` and `admins.name` are `varchar(100)`. A longer name
 *    reached the database and came back as a driver error — a 500 on an admin's
 *    own form, where a 400 naming the field is the whole point of having a DTO.
 *  - `password` fed argon2 unbounded, on endpoints that are deliberately
 *    UNAUTHENTICATED (invite-accept and login). Hashing cost rises with input
 *    length, so an uncapped field is a cheap way to make the server do expensive
 *    work. The throttles bound the rate; they do not bound the cost per request.
 */

const MASTER = { email: 'limits-master@oxshare.com', password: 'admin-password-123' };

let ctx: HttpTestContext;
let roleId: string;

beforeAll(async () => {
  ctx = await startHttpTestApp();
  const passwords = new PasswordService();

  const [masterRole] = await ctx.db.db
    .insert(roles)
    .values({ name: 'Limits Master', permissions: ['*'], isSystem: true })
    .returning();
  roleId = masterRole.id;

  await ctx.db.db.insert(admins).values({
    email: MASTER.email,
    passwordHash: await passwords.hash(MASTER.password),
    name: 'Limits Master',
    role: 'master_admin',
    roleId: masterRole.id,
    permissions: ['*'],
    status: 'active',
  });
});

afterAll(async () => {
  await stopHttpTestApp(ctx);
});

describe('inviting — the fields are bounded', () => {
  it('refuses a name longer than the column with 400, not a driver 500', async () => {
    // `varchar(100)`. Without a MaxLength this reached Postgres and surfaced as
    // an internal error on the inviting admin's own form.
    const master = await actingAs(ctx, 'admin', MASTER);
    const res = await master.post('/v1/admin/invite', {
      email: 'limits-longname@oxshare.com',
      name: 'x'.repeat(300),
      roleId,
    });

    expect(res.status).toBe(400);
  });

  it('refuses an over-long email the same way', async () => {
    const master = await actingAs(ctx, 'admin', MASTER);
    const res = await master.post('/v1/admin/invite', {
      email: `${'x'.repeat(300)}@oxshare.com`,
      name: 'Fine Name',
      roleId,
    });

    expect(res.status).toBe(400);
  });

  it('still accepts a realistic name', async () => {
    // The cap must not be so tight it rejects real people.
    const master = await actingAs(ctx, 'admin', MASTER);
    const res = await master.post('/v1/admin/invite', {
      email: 'limits-ok@oxshare.com',
      name: 'María-José van der Berg-Okonkwo',
      roleId,
    });

    expect([200, 201]).toContain(res.status);
  });
});

describe('accepting — the password is bounded at both ends', () => {
  it('refuses a password beyond the cap rather than hashing it', async () => {
    // Unauthenticated endpoint; argon2 cost grows with input length. The
    // throttle bounds the RATE, not the cost of one request.
    const res = await anonymous(ctx)
      .post('/v1/admin/invite/accept')
      .set('Origin', SURFACES.admin.origin)
      .send({ token: 'irrelevant-the-dto-runs-first', password: 'x'.repeat(5000) });

    expect(res.status).toBe(400);
  });

  it('still refuses a too-short password', async () => {
    const res = await anonymous(ctx)
      .post('/v1/admin/invite/accept')
      .set('Origin', SURFACES.admin.origin)
      .send({ token: 'irrelevant', password: 'short' });

    expect(res.status).toBe(400);
  });
});

describe('logging in — the same bound, on the same reasoning', () => {
  it('refuses an enormous password before it reaches argon2', async () => {
    const res = await anonymous(ctx)
      .post('/v1/admin/auth/login')
      .set('Origin', SURFACES.admin.origin)
      .send({ email: MASTER.email, password: 'x'.repeat(5000) });

    expect(res.status).toBe(400);
  });

  it('leaves a normal sign-in working', async () => {
    const session = await actingAs(ctx, 'admin', MASTER);
    await session.get('/v1/admin/auth/me').expect(200);
  });
});
