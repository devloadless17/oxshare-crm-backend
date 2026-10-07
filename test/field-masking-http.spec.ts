import { ALL_PERMISSIONS } from './support/all-permissions';
import { legacyRoute } from './support/payment-route';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { actingAs, startHttpTestApp, stopHttpTestApp, type HttpTestContext } from './http-setup';
import { PasswordService } from '../src/common/security/password.service';
import 'reflect-metadata';
import {
  ClientProfileDto,
  ClientRowDto,
  KycAttemptDto,
  KycSubmissionDto,
} from '../src/modules/admin/dto/responses.dto';
import {
  admins,
  ibAccruals,
  ibAccounts,
  ibApplications,
  ibProgramTiers,
  ibPrograms,
  kycSubmissionAttempts,
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
let clientId: number;

interface ListBody {
  items: Record<string, unknown>[];
  maskedFields: string[];
}

/**
 * The keys a DTO declares to Swagger — the set the response interceptor can
 * see, and therefore the only set it is able to mask. Hoisted to module scope
 * because two blocks assert against it now, and one definition is the point.
 */
const declaredOn = (dto: unknown): Set<string> => {
  const properties = Reflect.getMetadata(
    'swagger/apiModelPropertiesArray',
    (dto as { prototype: object }).prototype,
  ) as string[] | undefined;
  return new Set((properties ?? []).map((name) => name.replace(/^:/, '')));
};

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
      // `ib.partners.view` gates the profile's partner-network block. Without it that
      // block is absent and the downline mask assertion below would pass
      // vacuously — the strongest way for this file to lie.
      permissions: [
        'clients.view',
        'kyc.view',
        'kyc.review',
        'roles.create',
        'roles.edit',
        'ib.partners.view',
        // The two IB lists below are their own pages since 0203.
        'ib.applications.view',
        'ib.commissions.view',
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
  const [downline] = await db
    .insert(users)
    .values({
      email: 'mask-downline@oxshare-e2e.test',
      passwordHash: 'x',
      firstName: 'Downline',
      lastName: 'Client',
      referredByIbUserId: clientId,
    })
    .returning();

  /*
   * An APPLICATION and an ACCRUAL, so the three admin IB LISTS have rows.
   *
   * Those three routes declare no response type, so `FieldMaskInterceptor`
   * declined to act on them at all and they returned client email and name to a
   * reviewer whose role hides both — every other route in that controller
   * declares a shape. They are masked explicitly now (`ib-list-mask.dto.ts`),
   * and these fixtures are what stop the assertions passing on empty lists.
   *
   * The accrual names TWO people — the partner who earned it and the client who
   * generated it — and the case below asserts both, because a mask that reached
   * one of them would look entirely correct from the other's side.
   */
  await db.insert(ibApplications).values({ userId: clientId, status: 'approved' });
  await db.insert(ibAccruals).values({
    ibUserId: clientId,
    clientUserId: downline.id,
    sourceType: 'deal',
    sourceId: '11111111-2222-3333-4444-555555555555',
    depth: 1,
    rateValue: '10.0000',
    baseAmount: '100.00000000',
    amount: '10.00000000',
    currency: 'USD',
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
    ...legacyRoute('manual_test', 'withdrawal'),
    destination: 'mask-test-destination',
  });
});

afterAll(async () => {
  await stopHttpTestApp(ctx);
});

/*
 * Looked up by the COMPLETE address: under D-82 a role that hides client emails
 * finds nobody by a fragment of one (that search was the oracle), and these
 * cases are about what the found row shows, so they find it the one way that
 * role may.
 */
const TARGET_EMAIL = encodeURIComponent('mask-target@oxshare-e2e.test');

describe('the client list', () => {
  it('OMITS a masked field from every row — not null, not a placeholder', async () => {
    const session = await actingAs(ctx, 'admin', MASKED);
    const res = await session.get(`${CLIENTS}?q=${TARGET_EMAIL}`);
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
    const res = await session.get(`${CLIENTS}?q=${TARGET_EMAIL}`);

    expect(JSON.stringify(res.body)).not.toContain('mask-target@oxshare-e2e.test');
    expect(JSON.stringify(res.body)).not.toContain('+961 1 000 000');
  });

  it('says WHICH fields are hidden, so the UI can distinguish hidden from empty', async () => {
    const session = await actingAs(ctx, 'admin', MASKED);
    const res = await session.get(`${CLIENTS}?q=${TARGET_EMAIL}`);

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
    const res = await session.get(`${CLIENTS}?q=${TARGET_EMAIL}`);
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
    /*
     * A previously DECIDED attempt, carrying the same identity data. The
     * history endpoint reads this table, not the live submission — which is
     * exactly how it came to be the one KYC surface with no mask on it.
     */
    await ctx.db.db.insert(kycSubmissionAttempts).values({
      userId: clientId,
      attemptNo: 1,
      status: 'rejected',
      submittedAt: new Date(),
      reviewedAt: new Date(),
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
    expect((res.body as { userId: number }).userId).toBe(clientId);
  });

  it('hides them on the review QUEUE too', async () => {
    const session = await actingAs(ctx, 'admin', MASKED);
    const res = await session.get('/v1/admin/kyc?status=submitted&limit=100').expect(200);
    const text = JSON.stringify(res.body);
    expect(text).toContain(clientId);
    expect(text).not.toContain('mask-target@oxshare-e2e.test');
  });

  it('hides them in the HISTORY of previously decided attempts', async () => {
    /*
     * Found in the running console: a reviewer whose role hides `client.email`
     * read it straight off the history panel, one tab from the field that
     * correctly showed nothing.
     *
     * Every archived attempt carries the same `personalInfo` the detail masks
     * — email, phone, date of birth, nationality — and this endpoint never
     * called `applyMask`. That is the THIRD surface to have this exact hole
     * (the detail and the exports were the others), and the lesson each time
     * is the same: the alias expansion in `client-fields.json` is not the
     * enforcement. A response that does not call the mask is unmasked however
     * many aliases the catalogue declares.
     */
    const session = await actingAs(ctx, 'admin', MASKED);
    const res = await session.get(`/v1/admin/kyc/${clientId}/history`).expect(200);

    const text = JSON.stringify(res.body);
    expect(text).not.toContain('mask-target@oxshare-e2e.test');
    expect(text).not.toContain('+961 1 000 000');
    // A mask, not a 403: the attempt itself still arrives, with the parts this
    // reviewer may read.
    expect(text).toContain('Masked');
    expect(Array.isArray(res.body)).toBe(true);
  });

  it('still shows the master everything on the same screens', async () => {
    const session = await actingAs(ctx, 'admin', MASTER);
    const res = await session.get(`/v1/admin/kyc/${clientId}`).expect(200);
    expect(JSON.stringify(res.body)).toContain('mask-target@oxshare-e2e.test');
    // Including the history — the fix above is a mask per VIEWER, not a field
    // removed from the endpoint for everybody.
    const history = await session.get(`/v1/admin/kyc/${clientId}/history`).expect(200);
    expect(JSON.stringify(history.body)).toContain('mask-target@oxshare-e2e.test');
  });
});

describe('the DECISION is not a bypass either', () => {
  /*
   * The seventh RBAC-03 exposure, and the one with the sharpest shape.
   *
   * `getKyc` masks. The four TRANSITIONS on the same submission — claim,
   * release, approve, reject — returned the row straight from the service with
   * no mask at all. So a reviewer who could not see the client's phone number
   * on the review screen got it back in the response body of the Claim button
   * sitting on that screen. The read was protected and the write handed the
   * value over.
   *
   * Proved on the wire before the fix: PATCH .../claim returned
   * personalInfo.phone, personalInfo.dateOfBirth, personalInfo.nationality and
   * user.email, with no `maskedFields` key at all.
   *
   * The same hole was in the four withdrawal transitions, whose `WithdrawalRowDto`
   * nests `WithdrawalUserDto` and its email; `withdrawal-desk-masking` covers those.
   *
   * Written with BOTH legs, per the failure this suite has to avoid: a masked
   * admin who cannot REACH a route also returns no email, and "the address is
   * absent" is then true of a 403 body. Every case asserts 200, and the master
   * leg proves the value was there to be hidden.
   */

  it('hides the client on the CLAIM response, and says what it hid', async () => {
    const session = await actingAs(ctx, 'admin', MASKED);
    const res = await session.patch(`/v1/admin/kyc/${clientId}/claim`).expect(200);

    const text = JSON.stringify(res.body);
    expect(text).not.toContain('mask-target@oxshare-e2e.test');
    expect(text).not.toContain('+961 1 000 000');
    // A mask, not a 403 and not an empty body: the submission still arrives.
    expect((res.body as { userId: number }).userId).toBe(clientId);
    expect((res.body as { maskedFields: string[] }).maskedFields).toEqual(
      expect.arrayContaining(['kyc.user.email']),
    );
  });

  it('hides the client on the RELEASE response, which undoes the claim', async () => {
    const session = await actingAs(ctx, 'admin', MASKED);
    const res = await session.patch(`/v1/admin/kyc/${clientId}/release`).expect(200);

    const text = JSON.stringify(res.body);
    expect(text).not.toContain('mask-target@oxshare-e2e.test');
    expect(text).not.toContain('+961 1 000 000');
    expect((res.body as { status: string }).status).toBe('submitted');
  });

  it('the MASTER sees the address on the very same transition', async () => {
    /*
     * The control, and it is not optional. Without it every assertion above is
     * satisfied by a transition that returns nothing at all — and a mask that
     * empties the response is a broken screen, not a working control. This also
     * catches the catalogue half of the bug: a resource with no prefix in
     * `client-fields.json` passes the masked leg by masking nothing, and only
     * this leg notices the difference.
     */
    const session = await actingAs(ctx, 'admin', MASTER);
    const claimed = await session.patch(`/v1/admin/kyc/${clientId}/claim`).expect(200);
    expect(JSON.stringify(claimed.body)).toContain('mask-target@oxshare-e2e.test');

    // Left as it was found, so the ordering of this file cannot matter.
    await session.patch(`/v1/admin/kyc/${clientId}/release`).expect(200);
  });
});

describe('a DTO that under-declares its response is a hole in shape-masking', () => {
  /*
   * `applyMask` removes by PATH from the object that actually exists. The
   * response interceptor removes what the DECLARED shape says is there. Those
   * are only the same mechanism while the DTO is complete — and one was not.
   *
   * `UsersStore.findPage` has always projected `phone` onto every client row
   * and `ClientRowDto` never declared it, so the generated frontend types were
   * missing a field the API returns, and shape-masking could not see it.
   * Deleting `applyMaskAll` from `listClients` masked email, name and country
   * and leaked the phone number.
   *
   * So completeness is a SEPARATE property from having a shape at all, and
   * `response-shape-coverage.spec.ts` only enforces the second. This enforces
   * the first, where it can be observed rather than inferred: against a real
   * response, read as a MASTER so nothing has been masked away and every key
   * the endpoint can emit is present to be checked.
   *
   * ⚠️ ITS REACH, STATED PLAINLY, because the difference matters to whoever
   * reads a green suite:
   *
   *   catalogue → mark   universal. `mask-equivalence.spec.ts` builds an object
   *                      carrying every maskable path for every resource and
   *                      requires the shape mask to remove all of them. No
   *                      fixture, no HTTP, nothing skipped.
   *   response → declared  FIXTURE-BOUND. It needs a populated response, so it
   *                      covers the four surfaces below out of seventeen
   *                      person-carrying shapes.
   *
   * The residual is exposure 9's exact shape: a returned field that IS client
   * PII but has no catalogue key, so the universal check cannot see it —
   * `credentialsSentTo` was precisely that, and it was found by hand. Extending
   * this half means seeding rows for the remaining shapes, which is blocked on
   * the same fixture economics as the rest of the suite.
   */
  it('the client LIST declares every key it returns', async () => {
    const session = await actingAs(ctx, 'admin', MASTER);
    const res = await session.get(`${CLIENTS}?q=mask-target`).expect(200);

    const rows = (res.body as ListBody).items;
    expect(rows.length, 'nothing to check — the fixture is missing').toBeGreaterThan(0);

    const declared = declaredOn(ClientRowDto);
    const undeclared = [...new Set(rows.flatMap((row) => Object.keys(row)))].filter(
      (key) => !declared.has(key),
    );

    expect(
      undeclared,
      'These keys are RETURNED and not declared on ClientRowDto. Both frontends are ' +
        'missing them, and the response interceptor cannot mask what the shape does ' +
        `not mention:\n${undeclared.map((k) => `  ${k}`).join('\n')}`,
    ).toEqual([]);
  });

  it('the KYC DETAIL declares every key it returns', async () => {
    /*
     * The submission is the richest client shape in the product, and the one
     * whose history has already shipped unmasked once. Its `personalInfo` is a
     * free-form map by design — the builder lets operators add fields — so the
     * key check here is that everything AROUND that map is declared, since the
     * map itself is covered by prefix rather than by property.
     */
    const session = await actingAs(ctx, 'admin', MASTER);
    const res = await session.get(`/v1/admin/kyc/${clientId}`).expect(200);

    const declared = declaredOn(KycSubmissionDto);
    const undeclared = Object.keys(res.body as Record<string, unknown>).filter(
      (key) => !declared.has(key),
    );
    expect(
      undeclared,
      `Returned but not declared on KycSubmissionDto:\n${undeclared.map((k) => `  ${k}`).join('\n')}`,
    ).toEqual([]);
  });

  it('the KYC HISTORY declares every key it returns', async () => {
    const session = await actingAs(ctx, 'admin', MASTER);
    const res = await session.get(`/v1/admin/kyc/${clientId}/history`).expect(200);

    const rows = res.body as Record<string, unknown>[];
    if (rows.length === 0) return; // nothing archived yet — covered by the detail above

    const declared = declaredOn(KycAttemptDto);
    const undeclared = [...new Set(rows.flatMap((r) => Object.keys(r)))].filter(
      (key) => !declared.has(key),
    );
    expect(
      undeclared,
      `Returned but not declared on KycAttemptDto:\n${undeclared.map((k) => `  ${k}`).join('\n')}`,
    ).toEqual([]);
  });

  it('the client PROFILE declares every key it returns', async () => {
    const session = await actingAs(ctx, 'admin', MASTER);
    const res = await session.get(`${CLIENTS}/${clientId}`).expect(200);

    const declared = declaredOn(ClientProfileDto);
    const undeclared = Object.keys(res.body as Record<string, unknown>).filter(
      (key) => !declared.has(key),
    );

    expect(
      undeclared,
      `Returned but not declared on ClientProfileDto:\n${undeclared
        .map((k) => `  ${k}`)
        .join('\n')}`,
    ).toEqual([]);
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

    // The Portal ID is the identifier every screen names a client by, so it is
    // the one a role cannot hide — served locked, with the reason.
    const portalId = fields.find((f) => f.key === 'client.portalId');
    expect(portalId?.maskable).toBe(false);
    // "You cannot hide this" with no explanation reads as a bug.
    expect(portalId?.reason).toBeTruthy();

    // The uuid is INTERNAL: no screen shows it, so the role editor must not
    // offer it either — not even as a locked row that tells an administrator
    // a second, hidden identifier exists (owner's rule, 24 Sep 2026).
    expect(fields.find((f) => f.key === 'client.id')).toBeUndefined();
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

describe('the IB lists are not a bypass either', () => {
  /*
   * Three routes in `admin-ib.controller.ts` declared no `@ApiOkResponse({
   * type })` while returning client email, first name and last name. The
   * interceptor masks by walking a route's DECLARED type and passes the
   * response through untouched when there is none — so it was a structural
   * no-op on exactly the three routes that needed it, and on no others in that
   * file.
   *
   * Every case asserts the ROW IS PRESENT before asserting the field is gone.
   * An empty list withholds an email too, and would pass identically.
   */
  it('the application queue withholds the applicant’s email', async () => {
    const session = await actingAs(ctx, 'admin', MASKED);
    const res = await session.get('/v1/admin/ib/applications').expect(200);

    const body = res.body as { rows: { user: { id: number; email?: string } }[] };
    expect(body.rows.length, 'no applications — the mask case is vacuous').toBeGreaterThan(0);
    expect(body.rows.some((r) => r.user.id === clientId)).toBe(true);
    expect(JSON.stringify(body)).not.toContain('mask-target@oxshare-e2e.test');
  });

  it('the partner list withholds the partner’s email', async () => {
    const session = await actingAs(ctx, 'admin', MASKED);
    const res = await session.get('/v1/admin/ib/partners').expect(200);

    const body = res.body as { rows: { user: { id: string } }[] };
    expect(body.rows.length, 'no partners — the mask case is vacuous').toBeGreaterThan(0);
    expect(JSON.stringify(body)).not.toContain('mask-target@oxshare-e2e.test');
  });

  it('the accrual ledger withholds BOTH people’s email', async () => {
    /*
     * The partner AND the client. Territory scoping already nulls an
     * out-of-territory client here, which is a different control answering a
     * different question — this reviewer is unrestricted, so every row is in
     * territory and only the FIELD mask can withhold anything.
     */
    const session = await actingAs(ctx, 'admin', MASKED);
    const res = await session.get('/v1/admin/ib/accruals').expect(200);

    const body = res.body as { rows: unknown[] };
    expect(body.rows.length, 'no accruals — the mask case is vacuous').toBeGreaterThan(0);

    const serialised = JSON.stringify(body);
    expect(serialised, 'the partner’s email survived').not.toContain(
      'mask-target@oxshare-e2e.test',
    );
    expect(serialised, 'the client’s email survived').not.toContain(
      'mask-downline@oxshare-e2e.test',
    );
  });

  it('gives the MASTER all three in full — the mask is policy, not a dropped column', async () => {
    const session = await actingAs(ctx, 'admin', MASTER);

    const applications = await session.get('/v1/admin/ib/applications').expect(200);
    expect(JSON.stringify(applications.body)).toContain('mask-target@oxshare-e2e.test');

    const partners = await session.get('/v1/admin/ib/partners').expect(200);
    expect(JSON.stringify(partners.body)).toContain('mask-target@oxshare-e2e.test');

    const accruals = await session.get('/v1/admin/ib/accruals').expect(200);
    const serialised = JSON.stringify(accruals.body);
    expect(serialised).toContain('mask-target@oxshare-e2e.test');
    expect(serialised).toContain('mask-downline@oxshare-e2e.test');
  });
});
