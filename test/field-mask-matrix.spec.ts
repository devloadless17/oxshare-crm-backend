import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ALL_PERMISSIONS } from './support/all-permissions';
import { actingAs, startHttpTestApp, stopHttpTestApp, type HttpTestContext } from './http-setup';
import { PasswordService } from '../src/common/security/password.service';
import {
  admins,
  clientTagAssignments,
  clientTags,
  kycConfigSteps,
  kycSubmissions,
  roles,
  users,
} from '../src/database/schema';
import { DEFAULT_KYC_STEPS } from '../src/store/kyc-config.store';

/**
 * EACH MASKABLE FIELD, ON ITS OWN.
 *
 * Every other masking test hides two or three fields together, which answers
 * "does masking work" and leaves the two questions an operator actually has
 * unanswered:
 *
 *   1. If I hide ONE field, is that field gone — on every screen it appears on,
 *      under every name it travels by?
 *   2. Is everything ELSE still there? A mask that quietly takes a neighbour
 *      with it is a broken screen, and it would pass every "the secret is
 *      absent" assertion ever written.
 *
 * The second is the one nothing else covers. `client.firstName` and
 * `client.lastName` differ by four characters and expand to eight aliases
 * between them; `client.address` is a prefix of nothing but sits beside
 * `addressProof`, which is a document reference and must survive. A
 * mask that over-reaches is invisible to a suite that only looks for what
 * should be gone.
 *
 * So this drives the catalogue itself: for every maskable key, a role that
 * hides EXACTLY that key, and both halves asserted — the field and its aliases
 * absent, every other maskable value still present.
 *
 * ## Role and override are both tested, because they are different code
 *
 * `resolveMaskedFields` inherits the role's mask when the admin's own column is
 * NULL and pins the admin's own array when it is set — including `[]`, which
 * UN-masks somebody whose role masks. That last case is the one worth pinning
 * hardest: it is the only way a mask is removed, and reading it as "empty means
 * inherit" would silently re-mask an operator the broker deliberately exempted.
 */

const MASTER = { email: 'matrix-master@oxshare.com', password: 'admin-password-123' };

/** The client every case reads, with a distinct value in every maskable field. */
const TARGET = {
  email: 'matrix-target@oxshare-e2e.test',
  firstName: 'MatrixFirst',
  lastName: 'MatrixLast',
  phone: '+961 9 999 001',
  country: 'Lebanon',
  // The rest of the PROFILE (0139) — stored on the client, shown on the client
  // screen AND inside the KYC review's personal answers, masked in both.
  dateOfBirth: '1979-03-14',
  nationality: 'MatrixNationality',
  address: 'MatrixStreet 12',
  city: 'MatrixCity',
  stateProvince: 'MatrixProvince',
  postalCode: 'MX 9901',
};

/** What a value looks like once the catalogue key is hidden, per key. */
const SENTINEL: Record<string, string> = {
  'client.firstName': TARGET.firstName,
  'client.lastName': TARGET.lastName,
  'client.email': TARGET.email,
  'client.phone': TARGET.phone,
  'client.country': TARGET.country,
  'client.dateOfBirth': TARGET.dateOfBirth,
  'client.nationality': TARGET.nationality,
  'client.address': TARGET.address,
  'client.city': TARGET.city,
  'client.stateProvince': TARGET.stateProvince,
  'client.postalCode': TARGET.postalCode,
  /*
   * A BROKER'S OWN questions, masked as ONE unit rather than per field.
   *
   * The slugs and field names are invented by a broker after this file ships,
   * so no catalogue entry could name them and no reader's mask could contain
   * one — `responses.dto.ts` records why a `@ClientFieldMap` prefix would have
   * looked like a control and masked nothing for ever. The sentinel is the
   * ANSWER, because that is the value a masked reader must stop seeing.
   *
   * It is the answer on a custom STEP and on the PERSONAL step both (below):
   * the personal step's own custom answers used to be maskable by nothing at
   * all, because they live in `personalInfo` under a key no catalogue entry
   * names. `ClientFieldMap`'s `others` rule puts them under this key too.
   */
  'kyc.stepData': 'MatrixSourceOfFunds',
  // Filled in `beforeAll`: one is a tag label, the other the row's real
  // timestamp. Both are maskable keys, and a key with no distinguishable value
  // in the fixture is a key this file would silently not be testing.
  'client.tags': 'MatrixTagLabel',
  'client.createdAt': '',
};

let ctx: HttpTestContext;
let clientId: string;
let maskableKeys: string[];

/** Every maskable key the catalogue offers, read from the file the API serves. */
function catalogueKeys(): string[] {
  const catalogue = JSON.parse(
    readFileSync(join(__dirname, '..', 'src', 'config', 'client-fields.json'), 'utf8'),
  ) as Record<string, { fields?: { key?: string; maskable?: boolean }[] }>;

  const keys: string[] = [];
  for (const [group, value] of Object.entries(catalogue)) {
    if (group === '$comment' || typeof value !== 'object' || value === null) continue;
    for (const field of value.fields ?? []) {
      if (field.key && field.maskable !== false) keys.push(field.key);
    }
  }
  return keys;
}

/** An admin whose ROLE hides exactly `masked`, or whose OWN column does. */
async function reader(masked: string[], where: 'role' | 'override') {
  const db = ctx.db.db;
  const passwords = new PasswordService();
  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const email = `matrix-${where}-${stamp}@oxshare.com`;
  const password = 'admin-password-123';

  const [role] = await db
    .insert(roles)
    .values({
      name: `Matrix ${where} ${stamp}`,
      // Everything, so a 403 can never be what makes a value absent.
      permissions: ALL_PERMISSIONS,
      maskedFields: where === 'role' ? masked : [],
    })
    .returning();

  await db.insert(admins).values({
    email,
    passwordHash: await passwords.hash(password),
    name: `Matrix ${where}`,
    role: 'sub_admin',
    roleId: role.id,
    permissions: [],
    // NULL means "inherit the role"; an array pins this person's own answer.
    maskedFields: where === 'override' ? masked : null,
    status: 'active',
  });

  return actingAs(ctx, 'admin', { email, password });
}

/** Every value the client screens can show, as one string, for one key. */
async function wireFor(session: Awaited<ReturnType<typeof reader>>): Promise<string> {
  const [profile, list, kyc] = await Promise.all([
    session.get(`/v1/admin/clients/${clientId}`),
    session.get(`/v1/admin/clients?q=matrix-target`),
    session.get(`/v1/admin/kyc/${clientId}`),
  ]);

  // A refusal would make every value absent and every assertion below vacuous.
  expect(profile.status, 'the profile refused').toBe(200);
  expect(list.status, 'the list refused').toBe(200);
  expect(kyc.status, 'the KYC detail refused').toBe(200);

  return JSON.stringify([profile.body, list.body, kyc.body]);
}

beforeAll(async () => {
  ctx = await startHttpTestApp();
  const db = ctx.db.db;
  const passwords = new PasswordService();

  const [masterRole] = await db
    .insert(roles)
    .values({ name: 'Matrix Master', permissions: ALL_PERMISSIONS, isSystem: true })
    .returning();
  await db.insert(admins).values({
    email: MASTER.email,
    passwordHash: await passwords.hash(MASTER.password),
    name: 'Matrix Master',
    role: 'master_admin',
    roleId: masterRole.id,
    permissions: ALL_PERMISSIONS,
    status: 'active',
  });

  const [client] = await db
    .insert(users)
    .values({ ...TARGET, passwordHash: 'x', emailVerified: true })
    .returning();
  clientId = client.id;

  /*
   * The KYC form, with a broker's own question on the personal step. The
   * review's personal answers are the PROFILE's values for the fields this step
   * asks for, merged with the step's own answers — so without the config the
   * KYC screen would carry none of the profile, and this file would test the
   * masking of the client screen alone.
   */
  await db.insert(kycConfigSteps).values(
    DEFAULT_KYC_STEPS.map((step, idx) => ({
      id: step.id,
      stepNumber: idx + 1,
      slug: step.slug,
      title: step.title,
      description: step.description,
      icon: step.icon,
      enabled: step.enabled,
      fields: (step.slug === 'personal'
        ? [
            ...step.fields,
            { id: 'f-occupation', name: 'customField_1', label: 'Occupation', type: 'text' },
          ]
        : step.fields) as unknown as Record<string, unknown>[],
    })),
  );

  await db.insert(kycSubmissions).values({
    userId: clientId,
    status: 'submitted',
    submittedAt: new Date(),
    // Only what a broker invented lives here (0139); the identity is the profile's.
    personalInfo: { customField_1: SENTINEL['kyc.stepData'] },
    document: { docType: 'passport' },
    // One custom step, so `kyc.stepData` has something to hide. Without it the
    // key is maskable in the catalogue and untested here, which this file's own
    // guard refuses — a key with no distinguishable value is one it would
    // silently not be testing.
    stepData: { 'compliance-questions': { sourceOfFunds: SENTINEL['kyc.stepData'] } },
    // A real page: evidence is read from the client's record, which holds pages
    // — a name with no file is nothing a client ever presented.
    addressProof: {
      docType: 'utility_bill',
      filePath: 'uploads/kyc/matrix-proof.pdf',
      fileName: 'MatrixProofFile.pdf',
    },
  });

  /*
   * `client.createdAt` is maskable and is a TIMESTAMP, so its sentinel has to be
   * the row's own value rather than a literal — serialised the way the API
   * serialises it, which is what a reader would actually receive.
   */
  SENTINEL['client.createdAt'] = new Date(client.createdAt).toISOString();

  const [tag] = await db
    .insert(clientTags)
    .values({ slug: `matrix-tag-${Date.now()}`, label: SENTINEL['client.tags'] })
    .returning();
  await db.insert(clientTagAssignments).values({ userId: clientId, tagId: tag.id });

  maskableKeys = catalogueKeys();
}, 120_000);

afterAll(async () => {
  await stopHttpTestApp(ctx);
});

describe('every maskable field, hidden on its own', () => {
  it('the catalogue offers the keys this file drives, so it cannot pass vacuously', () => {
    expect(maskableKeys.length).toBeGreaterThanOrEqual(8);
    for (const key of maskableKeys) {
      expect(SENTINEL[key], `${key} has no distinguishable value in the fixture`).toBeDefined();
    }
  });

  it('an UNMASKED reader sees every one of them — the control', async () => {
    /*
     * Without this the whole file could pass against a fixture that never had
     * the values, or screens that answered empty. Every "absent" assertion
     * below is only meaningful because this one says they were present.
     */
    const wire = await wireFor(await reader([], 'role'));
    const missing = maskableKeys.filter((key) => !wire.includes(SENTINEL[key]));
    expect(
      missing,
      `the fixture never carried these, so masking them proves nothing:\n${missing.join('\n')}`,
    ).toEqual([]);
  });

  for (const via of ['role', 'override'] as const) {
    describe(`masked on the ${via}`, () => {
      it(`hides each key on its own, and nothing else, via the ${via}`, async () => {
        const problems: string[] = [];

        for (const key of maskableKeys) {
          const wire = await wireFor(await reader([key], via));

          // 1. THE FIELD IS GONE — under every name the catalogue expands it to.
          if (wire.includes(SENTINEL[key])) {
            problems.push(`${key}: hidden by the ${via}, still on the wire`);
          }

          // 2. NOTHING ELSE WENT WITH IT. The half no other suite checks.
          for (const other of maskableKeys) {
            if (other === key) continue;
            if (!wire.includes(SENTINEL[other])) {
              problems.push(`${key}: masking it also removed ${other}`);
            }
          }

          // 3. The screens still WORK — a document reference beside the address
          //    is not the address, and must survive being near it.
          if (!wire.includes('MatrixProofFile.pdf')) {
            problems.push(`${key}: masking it also removed the address-proof document`);
          }
          if (!wire.includes(clientId)) {
            problems.push(`${key}: masking it emptied the response`);
          }
        }

        expect(problems, problems.join('\n')).toEqual([]);
      }, 240_000);
    });
  }

  it('an OVERRIDE of [] un-masks somebody whose role masks', async () => {
    /*
     * The only way a mask is REMOVED, and the one reading of the column that
     * would silently re-mask an operator the broker deliberately exempted:
     * treating `[]` as "nothing set, inherit the role" rather than as this
     * person's own answer. `resolveMaskedFields` distinguishes them by
     * `undefined` versus an array, and this is what pins that.
     */
    const db = ctx.db.db;
    const passwords = new PasswordService();
    const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const email = `matrix-exempt-${stamp}@oxshare.com`;
    const password = 'admin-password-123';

    const [role] = await db
      .insert(roles)
      .values({
        name: `Matrix Exempt ${stamp}`,
        permissions: ALL_PERMISSIONS,
        maskedFields: ['client.email', 'client.phone'],
      })
      .returning();

    await db.insert(admins).values({
      email,
      passwordHash: await passwords.hash(password),
      name: 'Matrix Exempt',
      role: 'sub_admin',
      roleId: role.id,
      permissions: [],
      maskedFields: [], // their own answer: hide nothing
      status: 'active',
    });

    const wire = await wireFor(await actingAs(ctx, 'admin', { email, password }));
    expect(wire, 'the empty override was read as inherit, and the role re-masked them').toContain(
      TARGET.email,
    );
    expect(wire).toContain(TARGET.phone);
  }, 120_000);

  it('an OVERRIDE hides a field the role does not', async () => {
    // The other direction: the person is narrower than the job.
    const wire = await wireFor(await reader(['client.country'], 'override'));
    expect(wire).not.toContain(TARGET.country);
    // And only that one — the role masked nothing, so the rest must remain.
    expect(wire).toContain(TARGET.email);
    expect(wire).toContain(TARGET.phone);
  }, 120_000);
});
