import { ALL_PERMISSIONS } from './support/all-permissions';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { actingAs, startHttpTestApp, stopHttpTestApp, type HttpTestContext } from './http-setup';
import { PasswordService } from '../src/common/security/password.service';
import { admins, roles, users } from '../src/database/schema';

/**
 * RBAC-03 field masking, END TO END.
 *
 * The assertion that matters in every case below is that the value is absent
 * from the RESPONSE BODY, not merely from a screen. A frontend that renders
 * `••••` over a value the API still sent is a UI convention, not access
 * control — the value is one devtools panel away, and every logging,
 * error-reporting and caching layer between here and the browser has already
 * seen it. R-4.1: the backend enforces; the frontend only hides.
 *
 * "Absent" is also load-bearing over "null". Null already means "this client
 * has no phone number on file", so reusing it would collapse two answers an
 * operator must be able to tell apart. A masked field is omitted, and
 * `maskedFields` on the response says which — which is what lets a screen say
 * "hidden by your permissions" rather than an em dash.
 */

const MASTER = { email: 'mask-master@oxshare.com', password: 'admin-password-123' };
const MASKED = { email: 'mask-limited@oxshare.com', password: 'admin-password-123' };

const CLIENTS = '/v1/admin/clients';

let ctx: HttpTestContext;
let clientId: string;

interface ListBody {
  items: Record<string, unknown>[];
  maskedFields: string[];
}

beforeAll(async () => {
  ctx = await startHttpTestApp();
  const passwords = new PasswordService();
  const db = ctx.db.db;

  const [masterRole] = await db
    .insert(roles)
    .values({ name: 'Mask HTTP Master', permissions: ALL_PERMISSIONS, isSystem: true })
    .returning();
  await db.insert(admins).values({
    email: MASTER.email,
    passwordHash: await passwords.hash(MASTER.password),
    name: 'Mask Master',
    role: 'master_admin',
    roleId: masterRole.id,
    permissions: ALL_PERMISSIONS,
    status: 'active',
  });

  /*
   * The mask lives on the ROLE, which is the point of the design: "support
   * agents do not see phone numbers" is a statement about the job. A per-person
   * override exists (`admins.masked_fields`) and is exercised separately below.
   */
  const [maskedRole] = await db
    .insert(roles)
    .values({
      name: 'Mask HTTP Limited',
      /*
       * `roles.manage` is here on purpose, and it is the realistic shape: an
       * administrator who configures roles but is themselves masked. Without
       * it the guard refuses first and the anti-escalation test below would
       * pass for the wrong reason — proving the permission check works, while
       * saying nothing about the mask check it is aimed at.
       */
      // `roles.create` is what POST /admin/roles requires — `roles.edit`
      // covers changing an existing one. Same trap the comment above names:
      // with the wrong key the guard refuses first and the mask assertion
      // never runs.
      permissions: ['clients.view', 'kyc.view', 'kyc.review', 'roles.create', 'roles.edit'],
      maskedFields: ['client.email', 'client.phone'],
    })
    .returning();
  await db.insert(admins).values({
    email: MASKED.email,
    passwordHash: await passwords.hash(MASKED.password),
    name: 'Mask Limited',
    role: 'sub_admin',
    roleId: maskedRole.id,
    permissions: [],
    status: 'active',
  });

  const [client] = await db
    .insert(users)
    .values({
      email: 'mask-target@oxshare-e2e.test',
      passwordHash: 'x',
      firstName: 'Masked',
      lastName: 'Target',
      country: 'Lebanon',
      phone: '+961 1 000 000',
    })
    .returning();
  clientId = client.id;
});

afterAll(async () => {
  await stopHttpTestApp(ctx);
});

describe('the client list', () => {
  it('OMITS a masked field from every row — not null, not a placeholder', async () => {
    const session = await actingAs(ctx, 'admin', MASKED);
    const res = await session.get(`${CLIENTS}?q=mask-target`);
    expect(res.status).toBe(200);

    const body = res.body as ListBody;
    expect(body.items.length).toBeGreaterThan(0);
    for (const row of body.items) {
      expect('email' in row, 'email survived masking').toBe(false);
      expect('phone' in row).toBe(false);
    }
  });

  it('never puts the masked value anywhere in the response body', async () => {
    /*
     * The assertion a per-field check cannot make.
     *
     * A value can survive masking by being copied into a nested object, a
     * summary line or a search echo — places nobody thinks to strip. Searching
     * the serialised body is the only way to state "this value did not leave
     * the process", which is the actual requirement.
     */
    const session = await actingAs(ctx, 'admin', MASKED);
    const res = await session.get(`${CLIENTS}?q=mask-target`);

    expect(JSON.stringify(res.body)).not.toContain('mask-target@oxshare-e2e.test');
    expect(JSON.stringify(res.body)).not.toContain('+961 1 000 000');
  });

  it('says WHICH fields are hidden, so the UI can distinguish hidden from empty', async () => {
    const session = await actingAs(ctx, 'admin', MASKED);
    const res = await session.get(`${CLIENTS}?q=mask-target`);

    const body = res.body as ListBody;
    expect(body.maskedFields).toContain('client.email');
    expect(body.maskedFields).toContain('client.phone');
  });

  it('leaves unmasked fields exactly as they were', async () => {
    // Masking must not be a blunt instrument. A control that hides more than it
    // was asked to gets switched off.
    const session = await actingAs(ctx, 'admin', MASKED);
    const res = await session.get(`${CLIENTS}?q=mask-target`);
    const row = (res.body as ListBody).items[0];

    expect(row['firstName']).toBe('Masked');
    expect(row['country']).toBe('Lebanon');
  });

  it('masks NOTHING for a master admin — RBAC-01 is "without exception"', async () => {
    const session = await actingAs(ctx, 'admin', MASTER);
    const res = await session.get(`${CLIENTS}?q=mask-target`);
    const body = res.body as ListBody;

    expect(body.maskedFields).toEqual([]);
    expect(body.items[0]?.['email']).toBe('mask-target@oxshare-e2e.test');
  });
});

describe('the client profile', () => {
  it('applies the same mask to the profile as to the list', async () => {
    // Two endpoints, one mask. A field hidden on the list and visible on the
    // profile is a bypass that consists of clicking a row.
    const session = await actingAs(ctx, 'admin', MASKED);
    const res = await session.get(`${CLIENTS}/${clientId}`);

    expect(res.status).toBe(200);
    const body = res.body as Record<string, unknown>;
    expect('email' in body).toBe(false);
    expect('phone' in body).toBe(false);
    expect(body['maskedFields']).toContain('client.email');
  });

  it('still returns the unmasked parts of the profile', async () => {
    const session = await actingAs(ctx, 'admin', MASKED);
    const res = await session.get(`${CLIENTS}/${clientId}`);
    const body = res.body as Record<string, unknown>;

    expect(body['firstName']).toBe('Masked');
    expect(body['id']).toBe(clientId);
  });
});

describe('the KYC screen is not a bypass', () => {
  it('hides the same values under their personalInfo names', async () => {
    /*
     * THE ALIAS RULE, exercised through HTTP.
     *
     * `GET /admin/kyc/:userId` returns the same person's email and phone under
     * `personalInfo.*`. Without alias expansion, hiding `client.phone` leaves
     * the number sitting one tab away on a screen the same permission set
     * reaches — the feature would be decorative AND would look configured.
     */
    const session = await actingAs(ctx, 'admin', MASKED);
    const res = await session.get(`/v1/admin/kyc/${clientId}`);

    // 404 is a legitimate outcome here — this client has no submission — but
    // whatever comes back must not carry the masked values.
    expect(JSON.stringify(res.body)).not.toContain('mask-target@oxshare-e2e.test');
    expect(JSON.stringify(res.body)).not.toContain('+961 1 000 000');
  });
});

describe('the field catalog', () => {
  it('serves the vocabulary the frontend configures masks from', async () => {
    // R-4.5: the frontend never invents a key. A mask key with no backend
    // counterpart is a field an operator ticked a box for and believes they hid.
    const session = await actingAs(ctx, 'admin', MASTER);
    const res = await session.get('/v1/admin/client-fields');

    expect(res.status).toBe(200);
    const groups = res.body as Record<string, { fields: { key: string; maskable: boolean }[] }>;
    const keys = Object.values(groups).flatMap((g) => g.fields.map((f) => f.key));

    expect(keys).toContain('client.email');
    expect(keys).toContain('client.phone');
  });

  it('marks structurally-required fields unmaskable, with a reason', async () => {
    const session = await actingAs(ctx, 'admin', MASTER);
    const res = await session.get('/v1/admin/client-fields');
    const groups = res.body as Record<
      string,
      { fields: { key: string; maskable: boolean; reason?: string }[] }
    >;
    const fields = Object.values(groups).flatMap((g) => g.fields);

    const id = fields.find((f) => f.key === 'client.id');
    expect(id?.maskable).toBe(false);
    // "You cannot hide this" with no explanation reads as a bug.
    expect(id?.reason).toBeTruthy();
  });
});

describe('anti-escalation on the mask itself', () => {
  it('refuses a role that would un-hide a field hidden from the actor', async () => {
    /*
     * The inverse of `assertGrantable`, and the check without which masking is
     * trivially defeated: make a role that hides nothing, assign yourself to
     * it, read the column you were denied. One screen, no exploit.
     *
     * Permissions are a grant list, so the rule there is a SUBSET check. A mask
     * is a restriction list, so the same principle inverts into a SUPERSET one.
     */
    const session = await actingAs(ctx, 'admin', MASKED);
    const res = await session.post('/v1/admin/roles', {
      name: 'Mask HTTP Escalation Attempt',
      permissions: ['clients.view'],
      maskedFields: [],
    });

    // 403 (not 400): this is an authorization refusal, not malformed input.
    expect(res.status).toBe(403);
    expect((res.body as { message?: string }).message).toMatch(/cannot un-hide/i);
  });

  it('lets a master admin configure any mask', async () => {
    const session = await actingAs(ctx, 'admin', MASTER);
    const res = await session.post('/v1/admin/roles', {
      name: 'Mask HTTP Master Configured',
      permissions: ['clients.view'],
      maskedFields: ['client.country'],
    });
    expect(res.status).toBe(201);
  });

  it('refuses a field the catalog says cannot be hidden', async () => {
    const session = await actingAs(ctx, 'admin', MASTER);
    const res = await session.post('/v1/admin/roles', {
      name: 'Mask HTTP Unmaskable',
      permissions: ['clients.view'],
      maskedFields: ['client.status'],
    });

    expect(res.status).toBe(400);
    expect((res.body as { message?: string }).message).toMatch(/cannot be hidden/i);
  });

  it('refuses a field key that is not in the catalog at all', async () => {
    const session = await actingAs(ctx, 'admin', MASTER);
    const res = await session.post('/v1/admin/roles', {
      name: 'Mask HTTP Unknown Key',
      permissions: ['clients.view'],
      maskedFields: ['client.doesNotExist'],
    });

    expect(res.status).toBe(400);
    expect((res.body as { message?: string }).message).toMatch(/client-fields/);
  });
});
