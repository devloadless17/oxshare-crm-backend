import { ALL_PERMISSIONS } from './support/all-permissions';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { actingAs, startHttpTestApp, stopHttpTestApp, type HttpTestContext } from './http-setup';
import { PasswordService } from '../src/common/security/password.service';
import {
  admins,
  ibAccounts,
  ibLevels,
  ibPrograms,
  kycSubmissions,
  roles,
  users,
} from '../src/database/schema';

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
      // `ib.view` gates the profile's partner-network block. Without it that
      // block is absent and the downline mask assertion below would pass
      // vacuously — the strongest way for this file to lie.
      permissions: [
        'clients.view',
        'kyc.view',
        'kyc.review',
        'roles.create',
        'roles.edit',
        'ib.view',
      ],
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

  /*
   * A DOWNLINE, because the leak this file now guards was inside a LIST.
   *
   * `referredClients[].email` was unmaskable by construction: the mask walk
   * gave up the moment a path segment was an array, so a scoped reviewer could
   * read every referred client's name and address off the profile response
   * while their own screens withheld exactly those fields. A fixture with no
   * referred clients would make the assertion below pass without proving
   * anything at all.
   */
  const [level] = await db
    .insert(ibLevels)
    .values({ level: 1, name: 'Mask Level', rateValue: '10.0000' })
    .onConflictDoNothing()
    .returning();
  const [program] = await db
    .insert(ibPrograms)
    .values({ name: 'Mask Programme', mode: 'commission_only', level1Rate: '10.0000' })
    .returning();
  await db.insert(ibAccounts).values({
    userId: clientId,
    level: level?.level ?? 1,
    programId: program.id,
    referralCode: 'MASKIB1',
    active: true,
  });
  await db.insert(users).values({
    email: 'mask-downline@oxshare-e2e.test',
    passwordHash: 'x',
    firstName: 'Downline',
    lastName: 'Client',
    referredByIbUserId: clientId,
  });
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

  /*
   * ── THE LIST CASE, on the wire ────────────────────────────────────────────
   *
   * A field inside an array was unmaskable BY CONSTRUCTION: the mask walk
   * returned early the moment a path segment was a list, so no alias could
   * have closed this. The profile shipped a partner's whole downline — names
   * and email addresses — to a reviewer whose every other screen withheld
   * exactly those fields.
   *
   * Asserted with `toHaveProperty`, because RBAC-03's promise is that a masked
   * field is ABSENT rather than nulled, and only the key's absence proves it.
   */
  it('masks the same fields inside the referred-clients LIST', async () => {
    const session = await actingAs(ctx, 'admin', MASKED);
    const res = await session.get(`${CLIENTS}/${clientId}`);
    const body = res.body as Record<string, unknown>;

    const downline = body['referredClients'] as Record<string, unknown>[] | undefined;
    // Guards the fixture: an empty list would make every assertion below vacuous.
    expect(Array.isArray(downline) && downline.length > 0).toBe(true);

    for (const row of downline!) {
      expect(row).not.toHaveProperty('email');
      // The row itself survives — a mask hides a field, not the relationship.
      expect(row).toHaveProperty('clientUserId');
    }
    // And nowhere in the serialised body, which is the only claim that counts.
    expect(JSON.stringify(body)).not.toContain('mask-downline@oxshare-e2e.test');
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
  /*
   * THE ALIAS RULE, exercised through HTTP — against a submission that EXISTS.
   *
   * This used to accept a 404 ("this client has no submission") and assert on
   * its body, which contains nothing to begin with: a permanently green test
   * guarding a mask that was never applied on this surface. Now a submission
   * carrying the person's email and phone under `personalInfo.*` AND under the
   * nested `user.*` is inserted first, the read must succeed, and the values
   * must be absent from the detail and from the queue.
   */
  beforeAll(async () => {
    await ctx.db.db.insert(kycSubmissions).values({
      userId: clientId,
      status: 'submitted',
      submittedAt: new Date(),
      personalInfo: {
        firstName: 'Masked',
        lastName: 'Target',
        email: 'mask-target@oxshare-e2e.test',
        phone: '+961 1 000 000',
        country: 'Lebanon',
      },
    });
  });

  it('hides the same values on the KYC detail, under every name they travel by', async () => {
    const session = await actingAs(ctx, 'admin', MASKED);
    const res = await session.get(`/v1/admin/kyc/${clientId}`).expect(200);

    const text = JSON.stringify(res.body);
    expect(text).not.toContain('mask-target@oxshare-e2e.test');
    expect(text).not.toContain('+961 1 000 000');
    // And says so, so the screen can render "hidden" rather than blank.
    expect((res.body as { maskedFields: string[] }).maskedFields).toEqual(
      expect.arrayContaining(['kyc.personalInfo.email', 'kyc.user.email']),
    );
    // The unmasked parts still arrive — this is a mask, not a 403.
    expect((res.body as { userId: string }).userId).toBe(clientId);
  });

  it('hides them on the review QUEUE too', async () => {
    const session = await actingAs(ctx, 'admin', MASKED);
    const res = await session.get('/v1/admin/kyc?status=submitted&limit=100').expect(200);
    const text = JSON.stringify(res.body);
    expect(text).toContain(clientId);
    expect(text).not.toContain('mask-target@oxshare-e2e.test');
  });

  it('still shows the master everything on the same screens', async () => {
    const session = await actingAs(ctx, 'admin', MASTER);
    const res = await session.get(`/v1/admin/kyc/${clientId}`).expect(200);
    expect(JSON.stringify(res.body)).toContain('mask-target@oxshare-e2e.test');
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
