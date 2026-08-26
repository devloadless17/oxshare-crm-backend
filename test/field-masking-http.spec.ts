import { ALL_PERMISSIONS } from './support/all-permissions';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { actingAs, startHttpTestApp, stopHttpTestApp, type HttpTestContext } from './http-setup';
import { PasswordService } from '../src/common/security/password.service';
import {
  admins,
  ibAccounts,
  ibProgramTiers,
  ibPrograms,
  kycSubmissions,
  roles,
  transactions,
  users,
  wallets,
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
        // Same trap the two comments above name: without this the desk answers
        // 403 and the assertion below would pass while proving nothing.
        'withdrawals.view',
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
  const [program] = await db
    .insert(ibPrograms)
    .values({ name: 'Mask Programme', mode: 'commission_only' })
    .returning();
  await db.insert(ibProgramTiers).values({ programId: program.id, depth: 1, rate: '10.0000' });
  await db.insert(ibAccounts).values({
    userId: clientId,
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

  /*
   * A PENDING WITHDRAWAL, because the money queues join the same person under
   * a different name. See the withdrawal-desk block at the end of this file.
   */
  const [wallet] = await db
    .insert(wallets)
    .values({ userId: clientId, currency: 'USD', balance: '0', onHold: '0' })
    .returning();
  await db.insert(transactions).values({
    userId: clientId,
    walletId: wallet.id,
    direction: 'withdrawal',
    amount: '25.00000000',
    currency: 'USD',
    state: 'pending',
    provider: 'manual_test',
    destination: 'mask-test-destination',
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
    /*
     * A RESPONSE ONLY ANNOUNCES ITS OWN PATHS.
     *
     * `client.email` expands to aliases on four other surfaces — the KYC
     * screens, the profile's downline, the withdrawal desk, the CSV export.
     * None of them belongs here: a UI reading this list would render "hidden"
     * markers for fields these rows never carried.
     */
    expect(body.maskedFields.some((k) => !k.startsWith('client.'))).toBe(false);
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

/*
 * THE MONEY QUEUES JOIN THE SAME PERSON UNDER A DIFFERENT NAME.
 *
 * Every masking bypass this file has caught was the same mistake wearing a new
 * hat: a screen that shows a client without going through the client service.
 * First the client-edit endpoints, then the KYC review screen and its queue,
 * then the KYC export, then the profile's referrer and downline. The withdrawal
 * desk is the next one along — it selects `users.email/firstName/lastName` into
 * a nested `user` object so the operator can tell whose payout they are looking
 * at, and nothing on that path has ever consulted the mask.
 *
 * It is worth being precise about why this keeps happening, because the answer
 * is not "somebody forgot". `applyMask` is opt-in per response, so the DEFAULT
 * for any new screen is unmasked, and the failure is invisible: the screen works
 * perfectly, and only an admin who is supposed to be restricted can tell. The
 * mask is a property of the VIEWER, so every surface that renders a person owes
 * it a call — and the only thing that makes that reliable is a test per surface.
 *
 * The keys travel as `withdrawal.user.*` aliases of `client.email` and the two
 * name fields, for the same reason `kyc.user.*` exists: the catalog is
 * path-qualified, so a bare `email` cannot be masked in one response and left in
 * another. An operator ticks "Email address" once and it goes everywhere.
 */
describe('the withdrawal desk', () => {
  const WITHDRAWALS = '/v1/admin/withdrawals';

  it('OMITS the masked field from the client attached to each payout', async () => {
    const session = await actingAs(ctx, 'admin', MASKED);
    const res = await session.get(`${WITHDRAWALS}?state=pending`);
    expect(res.status).toBe(200);

    const body = res.body as ListBody;
    // Guards the fixture: an empty desk would make every assertion vacuous.
    expect(body.items.length, 'no withdrawals to assert on').toBeGreaterThan(0);

    for (const row of body.items) {
      const user = row['user'] as Record<string, unknown> | undefined;
      expect(user, 'the desk stopped attaching the client').toBeDefined();
      expect('email' in (user ?? {}), 'email survived masking on the desk').toBe(false);
      // The id has to stay — the row is addressed by it, and the catalog says
      // `client.id` is not maskable for exactly that reason.
      expect(user?.['id']).toBeDefined();
    }
  });

  it('never puts the masked value anywhere in the desk response', async () => {
    const session = await actingAs(ctx, 'admin', MASKED);
    const res = await session.get(`${WITHDRAWALS}?state=pending`);

    expect(JSON.stringify(res.body)).not.toContain('mask-target@oxshare-e2e.test');
  });

  it('tells the screen which fields it is missing, so it can say "hidden"', async () => {
    const session = await actingAs(ctx, 'admin', MASKED);
    const res = await session.get(`${WITHDRAWALS}?state=pending`);

    const body = res.body as ListBody;
    /*
     * The key is the one that names the path ON THIS RESPONSE, matching the
     * `kyc.*` convention: the frontend keys off the catalog key it was
     * configured from, and the desk nests the person under `user`. The CSV
     * export's flat spelling lives under its own prefix precisely so it does
     * not show up here, on rows that have no such field.
     */
    expect(body.maskedFields).toContain('withdrawal.user.email');
    expect(body.maskedFields, 'the export spelling leaked into the desk').not.toContain(
      'withdrawalExport.userEmail',
    );
  });

  it('still shows the master the client behind the payout', async () => {
    const session = await actingAs(ctx, 'admin', MASTER);
    const res = await session.get(`${WITHDRAWALS}?state=pending`);
    expect(res.status).toBe(200);

    const body = res.body as ListBody;
    const row = body.items.find(
      (r) => (r['user'] as Record<string, unknown> | undefined)?.['id'] === clientId,
    );
    expect(row, 'the fixture withdrawal is not on the master desk').toBeDefined();
    expect((row?.['user'] as Record<string, unknown>)['email']).toBe(
      'mask-target@oxshare-e2e.test',
    );
  });
});
