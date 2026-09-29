import { ALL_PERMISSIONS } from './support/all-permissions';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { eq, sql } from 'drizzle-orm';
import {
  actingAs,
  startHttpTestApp,
  stopHttpTestApp,
  type HttpTestContext,
  type Session,
} from './http-setup';
import { PasswordService } from '../src/common/security/password.service';
import { admins, kycConfigSteps, kycSubmissions, roles, users } from '../src/database/schema';
import { DEFAULT_KYC_STEPS } from '../src/store/kyc-config.store';

/**
 * A client's KYC, from the first answer to a corrected resubmission, over HTTP
 * against real Postgres — the four things reported from production on 24 Sep
 * 2026, each asserted on what the DATABASE holds afterwards:
 *
 *  1. The review screen posted its whole form as the personal step, and the
 *     reviewer read "Doc Choice Document" and "Custom Field 1790263652846:
 *     [object Object]" beside the client's name.
 *  2. A phone number of "+961" — a country code alone — was accepted.
 *  3. A passport was shown as uploaded for the national ID: every identity
 *     document shares one column and the upload never said which it was.
 *  4. Rejecting a passport told the client nothing, and the same passport could
 *     be sent straight back.
 */

const ADMIN = { email: 'kyc-round-admin@oxshare.com', password: 'admin-password-123' };
const PASSWORD = 'client-password-123';

const COMPLETE_PROFILE = {
  firstName: 'Round',
  lastName: 'Trip',
  dateOfBirth: '1990-01-01',
  phone: '+961 70 123 456',
  nationality: 'Lebanese',
  country: 'Lebanon',
  // Required to verify, by the platform (the identity core, 26 Sep 2026).
  address: 'Hamra Street 12',
  city: 'Beirut',
};

/** Starts with the PNG signature, which is what the upload route checks. */
const PNG = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.alloc(2048, 1),
]);

let ctx: HttpTestContext;
let passwordHash: string;

async function newClient(tag: string): Promise<{ id: number; session: Session }> {
  const email = `kyc-round-${tag}-${Date.now()}@oxshare-e2e.test`;
  const [user] = await ctx.db.db
    .insert(users)
    .values({ email, passwordHash, firstName: 'Round', lastName: 'Trip', emailVerified: true })
    .returning();
  return { id: user.id, session: await actingAs(ctx, 'portal', { email, password: PASSWORD }) };
}

function upload(session: Session, field: string, docType?: string) {
  const req = session.post('/v1/kyc/upload', undefined).field('field', field);
  if (docType) req.field('docType', docType);
  return req.attach('file', PNG, { filename: `${field}.png`, contentType: 'image/png' });
}

async function stored(userId: number) {
  const [row] = await ctx.db.db
    .select()
    .from(kycSubmissions)
    .where(eq(kycSubmissions.userId, userId));
  return row;
}

beforeAll(async () => {
  ctx = await startHttpTestApp();
  await ctx.db.db.insert(kycConfigSteps).values(
    DEFAULT_KYC_STEPS.map((s) => ({
      id: s.id,
      stepNumber: s.stepNumber,
      slug: s.slug,
      title: s.title,
      description: s.description,
      icon: s.icon,
      enabled: s.enabled,
      fields: s.fields as unknown as Record<string, unknown>[],
    })),
  );

  const passwords = new PasswordService();
  passwordHash = await passwords.hash(PASSWORD);
  const [role] = await ctx.db.db
    .insert(roles)
    .values({ name: 'Round Master', permissions: ALL_PERMISSIONS, isSystem: true })
    .returning();
  await ctx.db.db.insert(admins).values({
    email: ADMIN.email,
    passwordHash: await passwords.hash(ADMIN.password),
    name: 'Round Admin',
    role: 'master_admin',
    roleId: role.id,
    permissions: ALL_PERMISSIONS,
  });
}, 180_000);

afterAll(async () => {
  await stopHttpTestApp(ctx);
});

describe('a step stores what it asks for, and nothing else', () => {
  it('keeps the review screen’s whole form out of the personal details', async () => {
    const { id, session } = await newClient('debris');
    await session
      .post('/v1/kyc/step', {
        step: 'personal',
        data: {
          ...COMPLETE_PROFILE,
          __docChoice__document: 'passport',
          __docChoice__address: 'utilityBill',
          customField_1790263652846: '[object Object]',
          docType: 'passport',
        },
      })
      .expect(201);

    // None of the debris is stored anywhere — and neither is the identity, in
    // the submission: that is the PROFILE's, held once (0139).
    const row = await stored(id);
    expect(row.personalInfo).toEqual({});
    const [profile] = await ctx.db.db
      .select({
        firstName: users.firstName,
        lastName: users.lastName,
        dateOfBirth: users.dateOfBirth,
        phone: users.phone,
        nationality: users.nationality,
        country: users.country,
        address: users.address,
        city: users.city,
      })
      .from(users)
      .where(eq(users.id, id));
    // The phone in its one canonical shape, whatever spacing was typed.
    expect(profile).toEqual({ ...COMPLETE_PROFILE, phone: '+96170123456' });
  });

  it('never lets a step write a file path — only an upload stores a file', async () => {
    const { id, session } = await newClient('forge');
    await session
      .post('/v1/kyc/step', {
        step: 'document',
        data: { docType: 'passport', frontFilePath: 'uploads/kyc/someone-elses-passport.jpg' },
      })
      .expect(201);
    expect((await stored(id)).document).toEqual({ docType: 'passport' });
  });

  it('reads "+961" as no phone, and refuses a number cut short', async () => {
    const { id, session } = await newClient('phone');
    await session
      .post('/v1/kyc/step', { step: 'personal', data: { ...COMPLETE_PROFILE, phone: '+961' } })
      .expect(201);
    // The profile holds NO phone — not a "+961" nobody can dial — and the
    // submission holds no copy of it either (0139).
    const [profile] = await ctx.db.db
      .select({ phone: users.phone, dateOfBirth: users.dateOfBirth })
      .from(users)
      .where(eq(users.id, id));
    expect(profile).toEqual({ phone: null, dateOfBirth: COMPLETE_PROFILE.dateOfBirth });
    expect((await stored(id)).personalInfo).toEqual({});

    const res = await session.post('/v1/kyc/step', {
      step: 'personal',
      data: { ...COMPLETE_PROFILE, phone: '+961 70 12' },
    });
    expect(res.status).toBe(400);
    expect(JSON.stringify(res.body)).toMatch(/Phone Number is incomplete/);
  });
});

describe('an uploaded page belongs to the document the client chose', () => {
  it('starts afresh when the client switches document, so pages never mix', async () => {
    const { id, session } = await newClient('switch');
    await upload(session, 'doc_front', 'national_id').expect(201);
    await upload(session, 'doc_back', 'national_id').expect(201);
    let document = (await stored(id)).document as Record<string, unknown>;
    expect(document).toMatchObject({ docType: 'national_id' });
    expect(document.backFilePath).toEqual(expect.any(String));

    await upload(session, 'doc_front', 'passport').expect(201);
    document = (await stored(id)).document as Record<string, unknown>;
    expect(document.docType).toBe('passport');
    // The national ID's back does not survive as the passport's.
    expect(document.backFilePath).toBeUndefined();
  });

  it('refuses a proof of address in an identity slot', async () => {
    const { session } = await newClient('category');
    await upload(session, 'doc_front', 'utility_bill').expect(400);
  });

  it('asks for a national ID’s back before the submission can go', async () => {
    const { session } = await newClient('half-card');
    await session.post('/v1/kyc/step', { step: 'personal', data: COMPLETE_PROFILE }).expect(201);
    await upload(session, 'doc_front', 'national_id').expect(201);
    await upload(session, 'selfie').expect(201);
    await upload(session, 'address_proof', 'utility_bill').expect(201);

    const res = await session.post('/v1/kyc/submit');
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/National ID: Back Side is required/);
  });
});

describe('a returned document must be replaced before the submission goes back', () => {
  it('refuses the same passport, then accepts once it is replaced', async () => {
    const { id, session } = await newClient('returned');
    await session.post('/v1/kyc/step', { step: 'personal', data: COMPLETE_PROFILE }).expect(201);
    await upload(session, 'doc_front', 'passport').expect(201);
    await upload(session, 'selfie').expect(201);
    await upload(session, 'address_proof', 'utility_bill').expect(201);
    await session.post('/v1/kyc/submit').expect(201);

    const admin = await actingAs(ctx, 'admin', ADMIN);
    await admin
      .patch(`/v1/admin/kyc/${id}/reject`, {
        reason: 'The passport photo is blurred',
        rejectedFields: ['doc_front', 'dateOfBirth'],
      })
      .expect(200);

    // The same passport, straight back: refused, naming the document.
    const refused = await session.post('/v1/kyc/submit');
    expect(refused.status).toBe(400);
    expect(refused.body.message).toMatch(/replace the documents the reviewer returned: Passport/);

    // A typed flag is highlighted, not enforced: the date is re-saved unchanged.
    await session.post('/v1/kyc/step', { step: 'personal', data: COMPLETE_PROFILE }).expect(201);
    expect((await stored(id)).rejectedFields).toEqual(['doc_front', 'dateOfBirth']);

    // A new passport settles the flag it answers, and only that one.
    await upload(session, 'doc_front', 'passport').expect(201);
    expect((await stored(id)).rejectedFields).toEqual(['dateOfBirth']);

    await session.post('/v1/kyc/submit').expect(201);
    const after = await stored(id);
    expect(after.status).toBe('submitted');
    expect(after.rejectedFields).toBeNull();
  });

  /*
   * Reported 28 Sep 2026, twice over. The reviewer returns ONE page — a national
   * ID's back, a tenancy agreement's additional page — and the client, correcting
   * it, switches to a document without that page: a passport, a utility bill.
   * The upload replaced the old document, yet its returned page stayed flagged,
   * named after the new one ("Please upload a new Passport — the reviewer
   * returned the one on file"), and nothing but re-sending the old document
   * would let the client go on.
   */
  async function submittedAndReturned(
    tag: string,
    identity: string[],
    address: string[],
    flag: string,
  ) {
    const client = await newClient(tag);
    await client.session
      .post('/v1/kyc/step', { step: 'personal', data: COMPLETE_PROFILE })
      .expect(201);
    // Two identity pages mean a national ID, one a passport; two address pages
    // a tenancy agreement, one a utility bill.
    const identityType = identity.length === 2 ? 'national_id' : 'passport';
    const addressType = address.length === 2 ? 'tenancy_agreement' : 'utility_bill';
    for (const field of identity) await upload(client.session, field, identityType).expect(201);
    for (const field of address) await upload(client.session, field, addressType).expect(201);
    await upload(client.session, 'selfie').expect(201);
    await client.session.post('/v1/kyc/submit').expect(201);

    const admin = await actingAs(ctx, 'admin', ADMIN);
    await admin
      .patch(`/v1/admin/kyc/${client.id}/reject`, {
        reason: 'One page is unreadable',
        rejectedFields: [flag],
      })
      .expect(200);
    expect((await stored(client.id)).rejectedFields).toEqual([flag]);
    return client;
  }

  async function stepState(session: Session, slug: string) {
    const res = await session.get('/v1/kyc/status').expect(200);
    return (res.body.steps as { slug: string }[]).find((state) => state.slug === slug);
  }

  it('a returned national-ID back is answered by switching to a passport', async () => {
    const { id, session } = await submittedAndReturned(
      'switch-passport',
      ['doc_front', 'doc_back'],
      ['address_proof'],
      'doc_back',
    );
    // While the national ID is on file, its returned back blocks the step.
    expect(await stepState(session, 'document')).toMatchObject({
      complete: false,
      returned: [{ id: 'doc_back', label: 'National ID (Back Side)', blocking: true }],
    });

    await upload(session, 'doc_front', 'passport').expect(201);
    const row = await stored(id);
    expect(row.document).toMatchObject({ docType: 'passport' });
    expect((row.document as Record<string, unknown>).backFilePath).toBeUndefined();
    // The national ID went whole, and its returned back went with it.
    expect(row.rejectedFields).toEqual([]);
    expect(await stepState(session, 'document')).toMatchObject({
      complete: true,
      missing: [],
      returned: [],
    });

    await session.post('/v1/kyc/submit').expect(201);
    expect((await stored(id)).status).toBe('submitted');
  });

  it('a returned tenancy-agreement page is answered by switching to a utility bill', async () => {
    const { id, session } = await submittedAndReturned(
      'switch-bill',
      ['doc_front'],
      ['address_proof', 'address_proof_2'],
      'address_proof_2',
    );

    await upload(session, 'address_proof', 'utility_bill').expect(201);
    const row = await stored(id);
    expect(row.addressProof).toMatchObject({ docType: 'utility_bill' });
    expect((row.addressProof as Record<string, unknown>).page2FilePath).toBeUndefined();
    expect(row.rejectedFields).toEqual([]);
    expect(await stepState(session, 'address')).toMatchObject({ complete: true, returned: [] });

    await session.post('/v1/kyc/submit').expect(201);
    expect((await stored(id)).status).toBe('submitted');
  });

  it('keeps the rule: the same national ID with only a new FRONT still owes its returned back', async () => {
    const { id, session } = await submittedAndReturned(
      'same-card',
      ['doc_front', 'doc_back'],
      ['address_proof'],
      'doc_back',
    );

    await upload(session, 'doc_front', 'national_id').expect(201);
    expect((await stored(id)).rejectedFields).toEqual(['doc_back']);

    const refused = await session.post('/v1/kyc/submit');
    expect(refused.status).toBe(400);
    expect(refused.body.message).toMatch(
      /replace the documents the reviewer returned: National ID \(Back Side\)/,
    );
  });
});

describe('0136 takes the form debris out of personal_info', () => {
  const migration = readFileSync(
    'src/database/migrations/0136_kyc_personal_info_debris.sql',
    'utf8',
  );

  it('removes UI state, stringified files and copies of custom answers — and keeps answers', async () => {
    const { id } = await newClient('migration');
    await ctx.db.db.insert(kycSubmissions).values({
      userId: id,
      status: 'rejected',
      personalInfo: {
        ...COMPLETE_PROFILE,
        __docChoice__document: 'passport',
        customField_1790263652846: '[object Object]',
        customField_1790263641710: 'Acme Ltd',
        weird: { filePath: 'uploads/kyc/x.jpg' },
      } as never,
      stepData: {
        'source-of-funds': {
          customField_1790263641710: 'Acme Ltd',
          customField_1790263652846: { filePath: 'uploads/kyc/p.jpg', fileName: 'p.jpg' },
        },
      },
    });

    await ctx.db.db.execute(sql.raw(migration));
    expect((await stored(id)).personalInfo).toEqual(COMPLETE_PROFILE);
    // The custom step keeps its own answers — they were only ever COPIED.
    expect((await stored(id)).stepData['source-of-funds']).toMatchObject({
      customField_1790263641710: 'Acme Ltd',
    });

    // Safe to run again: nothing left to change.
    const second = await ctx.db.db.execute(sql.raw(migration));
    expect(second.rowCount).toBe(0);
  });
});
