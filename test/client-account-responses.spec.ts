import 'reflect-metadata';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { ALL_PERMISSIONS } from './support/all-permissions';
import { actingAs, startHttpTestApp, stopHttpTestApp, type HttpTestContext } from './http-setup';
import { PasswordService } from '../src/common/security/password.service';
import { admins, ibAccounts, roles, users } from '../src/database/schema';
import { ClientAccountDto } from '../src/modules/admin/dto/responses.dto';

/**
 * EVERY WRITE THAT ANSWERS WITH A CLIENT'S ACCOUNT ANSWERS WITH `ClientAccountDto`
 * — THE SHAPE, MASKED, AND NOTHING ELSE.
 *
 * Two of these routes did not, found by the 28 Sep 2026 masking audit:
 *
 *  - `PATCH /admin/clients/:id/referrer` returned the raw `users` row —
 *    `passwordHash`, the email-verification and password-reset token hashes —
 *    to any administrator holding `clients.referrer.set`. The route DECLARED
 *    `ClientAccountDto`; a declaration is a promise about the shape, not a
 *    filter, and nothing held the body to it.
 *  - `PATCH /admin/clients/:id/status` declared no response type at all, so the
 *    RBAC-03 interceptor had no shape to walk and returned email, name and
 *    country in the clear — while `maskedFields` said they were hidden.
 *
 * Each case below attempts the forbidden thing on the wire: a key outside the
 * declared shape, a credential hash, a masked value.
 */

const PASSWORD = 'admin-password-123';
const FULL = { email: 'account-resp-full@oxshare.com', password: PASSWORD };
/** Every permission these routes need, and a role that hides the email. */
const MASKED = { email: 'account-resp-masked@oxshare.com', password: PASSWORD };

const CLIENTS = '/v1/admin/clients';

let ctx: HttpTestContext;
let targetId: string;
let orphanId: string;
let partnerId: string;

/** Every property `ClientAccountDto` declares, read from the class itself. */
function declaredKeys(): Set<string> {
  const raw = (Reflect.getMetadata('swagger/apiModelPropertiesArray', ClientAccountDto.prototype) ??
    []) as string[];
  return new Set(raw.map((key) => key.replace(/^:/, '')));
}

function undeclaredKeysOf(body: Record<string, unknown>): string[] {
  const declared = declaredKeys();
  return Object.keys(body).filter((key) => !declared.has(key));
}

beforeAll(async () => {
  ctx = await startHttpTestApp();
  const db = ctx.db.db;
  const hash = await new PasswordService().hash(PASSWORD);

  const [fullRole] = await db
    .insert(roles)
    .values({ name: 'Account Resp Full', permissions: ALL_PERMISSIONS })
    .returning();
  await db.insert(admins).values({
    email: FULL.email,
    passwordHash: hash,
    name: 'Account Resp Full',
    role: 'sub_admin',
    roleId: fullRole.id,
    permissions: [],
    status: 'active',
  });

  const [maskedRole] = await db
    .insert(roles)
    .values({
      name: 'Account Resp Masked',
      permissions: ['clients.view', 'clients.suspend', 'clients.referrer.set'],
      maskedFields: ['client.email'],
    })
    .returning();
  await db.insert(admins).values({
    email: MASKED.email,
    passwordHash: hash,
    name: 'Account Resp Masked',
    role: 'sub_admin',
    roleId: maskedRole.id,
    permissions: [],
    status: 'active',
  });

  const client = async (label: string) => {
    const [row] = await db
      .insert(users)
      .values({
        email: `account-resp-${label}@oxshare-e2e.test`,
        passwordHash: 'a-real-looking-bcrypt-hash-that-must-never-leave',
        firstName: 'Account',
        lastName: label,
      })
      .returning();
    return row.id;
  };
  targetId = await client('target');
  orphanId = await client('orphan');
  partnerId = await client('partner');
  await db
    .insert(ibAccounts)
    .values({ userId: partnerId, level: 1, active: true, referralCode: 'ACCTRESP1' });
});

afterAll(async () => {
  await stopHttpTestApp(ctx);
});

beforeEach(async () => {
  await ctx.db.db.update(users).set({ referredByIbUserId: null }).where(eq(users.id, orphanId));
});

describe('PATCH /admin/clients/:id/referrer answers with the account, not the row', () => {
  it('returns no key its declared shape does not name — no password hash, no token hashes', async () => {
    const session = await actingAs(ctx, 'admin', FULL);
    const res = await session
      .patch(`${CLIENTS}/${orphanId}/referrer`)
      .send({ referralCode: 'ACCTRESP1' });
    expect(res.status).toBe(200);

    const body = res.body as Record<string, unknown>;
    expect(undeclaredKeysOf(body), 'keys outside ClientAccountDto reached the wire').toEqual([]);
    const serialised = JSON.stringify(body);
    expect(serialised).not.toContain('a-real-looking-bcrypt-hash');
    expect(body).not.toHaveProperty('passwordHash');
    expect(body).not.toHaveProperty('emailVerificationTokenHash');
    expect(body).not.toHaveProperty('passwordResetTokenHash');
    // The shape it promised is really there.
    expect(body).toMatchObject({ id: orphanId, email: 'account-resp-orphan@oxshare-e2e.test' });
  });

  it('masks what the reader’s role hides, and says so', async () => {
    const session = await actingAs(ctx, 'admin', MASKED);
    const res = await session
      .patch(`${CLIENTS}/${orphanId}/referrer`)
      .send({ referralCode: 'ACCTRESP1' });
    expect(res.status).toBe(200);

    const body = res.body as Record<string, unknown>;
    expect(body).not.toHaveProperty('email');
    expect(body.maskedFields).toContain('client.email');
    expect(undeclaredKeysOf(body)).toEqual([]);
  });
});

describe('PATCH /admin/clients/:id/status is masked like every other client read', () => {
  it('withholds a masked email — the value the old response leaked', async () => {
    const session = await actingAs(ctx, 'admin', MASKED);
    const res = await session.patch(`${CLIENTS}/${targetId}/status`, { status: 'suspended' });
    expect(res.status).toBe(200);

    const body = res.body as Record<string, unknown>;
    expect(body, 'a masked reader read the email out of a status change').not.toHaveProperty(
      'email',
    );
    expect(JSON.stringify(body)).not.toContain('account-resp-target@oxshare-e2e.test');
    expect(body.maskedFields).toContain('client.email');
    expect(body.status).toBe('suspended');
    expect(undeclaredKeysOf(body)).toEqual([]);

    await session.patch(`${CLIENTS}/${targetId}/status`, { status: 'active' }).expect(200);
  });

  it('still shows an unmasked reader everything the shape declares', async () => {
    // The control: without it, "no email" would also pass against a response
    // that had simply stopped carrying one.
    // A real change: the service refuses a no-op status write.
    const session = await actingAs(ctx, 'admin', FULL);
    const res = await session.patch(`${CLIENTS}/${targetId}/status`, { status: 'suspended' });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ email: 'account-resp-target@oxshare-e2e.test' });
    expect(undeclaredKeysOf(res.body as Record<string, unknown>)).toEqual([]);

    await session.patch(`${CLIENTS}/${targetId}/status`, { status: 'active' }).expect(200);
  });
});
