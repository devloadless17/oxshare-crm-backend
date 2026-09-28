import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { actingAs, startHttpTestApp, stopHttpTestApp, type HttpTestContext } from './http-setup';
import { PasswordService } from '../src/common/security/password.service';
import { admins, roles, users } from '../src/database/schema';

/**
 * A MASKED ADMINISTRATOR CANNOT CREATE SIGHT THEY DO NOT HAVE (0155).
 *
 * Two doors the 28 Sep 2026 masking audit found open:
 *  - an API key authenticated with an EMPTY mask, so a masked admin holding
 *    `apikeys.create` minted one and read every email through it;
 *  - an invite could hand the invitee an UNMASKED role, because only a mask
 *    somebody typed was compared, never the one a role brings.
 */

const PASSWORD = 'admin-password-123';
const MASKED = { email: 'maskesc-admin@oxshare.com', password: PASSWORD };
const CLIENT_EMAIL = 'maskesc-client@oxshare-e2e.test';

let ctx: HttpTestContext;
let unmaskedRoleId: string;

beforeAll(async () => {
  ctx = await startHttpTestApp();
  const db = ctx.db.db;
  const hash = await new PasswordService().hash(PASSWORD);

  const [maskedRole] = await db
    .insert(roles)
    .values({
      name: 'MaskEsc Masked',
      permissions: [
        'clients.view',
        'apikeys.create',
        'admins.create',
        'admins.scope',
        'kyc.review',
      ],
      maskedFields: ['client.email'],
    })
    .returning();
  const [unmaskedRole] = await db
    .insert(roles)
    .values({ name: 'MaskEsc Unmasked', permissions: ['kyc.review'] })
    .returning();
  unmaskedRoleId = unmaskedRole.id;

  await db.insert(admins).values({
    email: MASKED.email,
    passwordHash: hash,
    name: 'MaskEsc Admin',
    role: 'sub_admin',
    roleId: maskedRole.id,
    permissions: [],
    status: 'active',
  });
  await db
    .insert(users)
    .values({ email: CLIENT_EMAIL, passwordHash: 'x', firstName: 'Mask', lastName: 'Esc' });
});

afterAll(async () => {
  await stopHttpTestApp(ctx);
});

describe('a masked administrator', () => {
  it('cannot read a hidden field through an API key they mint', async () => {
    const session = await actingAs(ctx, 'admin', MASKED);
    const minted = await session
      .post('/v1/admin/api-keys', { name: 'MaskEsc key', permissions: ['clients.view'] })
      .expect(201);
    const plaintext = (minted.body as { plaintext: string }).plaintext;

    const res = await request(ctx.app.getHttpServer())
      .get('/v1/admin/clients?q=maskesc-client&limit=5')
      .set('X-API-Key', plaintext)
      .expect(200);

    const serialised = JSON.stringify(res.body);
    expect(serialised, 'the key read an email its creator may not').not.toContain(CLIENT_EMAIL);
    expect((res.body as { items: unknown[] }).items.length).toBeGreaterThan(0);
  });

  it('cannot invite a colleague onto a role that hides less than theirs', async () => {
    const session = await actingAs(ctx, 'admin', MASKED);
    const res = await session.post('/v1/admin/invite', {
      email: 'maskesc-invitee@oxshare.com',
      name: 'Invitee',
      roleId: unmaskedRoleId,
    });
    expect(res.status, 'an unmasked colleague was minted by a masked admin').toBe(403);
  });
});
