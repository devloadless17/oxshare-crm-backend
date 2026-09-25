import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { ALL_PERMISSIONS } from './support/all-permissions';
import {
  actingAs,
  anonymous,
  startHttpTestApp,
  stopHttpTestApp,
  type HttpTestContext,
} from './http-setup';
import { PasswordService } from '../src/common/security/password.service';
import {
  admins,
  auditLog,
  kycConfigSteps,
  kycSubmissions,
  roles,
  users,
} from '../src/database/schema';
import { DEFAULT_KYC_STEPS } from '../src/store/kyc-config.store';
import { UsersStore } from '../src/store/users.store';
import { KYC_COUNTRY_OPTIONS, KYC_NATIONALITY_OPTIONS } from '../src/common/kyc/country-options';

/**
 * ONE CLIENT, ONE PROFILE — the guarantee migration 0139 exists for, proven
 * end to end over the routes people actually use.
 *
 * The report that started it: a client could register as "t1" and verify as
 * "test1", and hold both names for ever — the account said one thing, the KYC
 * submission another, and the admin review printed them side by side. The fix
 * is structural: every identity field has one home (the `users` row), every
 * writer goes through one validated, audited write path, and the KYC form
 * reads and writes that same record.
 *
 * So these cases never assert a copy was made; they assert there is nothing to
 * copy. Whatever the client typed at sign-up is what the KYC form shows; what
 * the KYC form changes is what the account and the desk see; what a reviewer
 * is checking cannot move under them.
 */

const ORIGIN = process.env['PORTAL_URL'] ?? 'http://localhost:3000';
const REGISTER = '/v1/auth/register';
const MASTER = { email: 'single-home-master@oxshare.com', password: 'admin-password-123' };
const PASSWORD = 'single-home-password-1';

/** A sign-up the way a person types it — spaces, a lower-case postcode, a spaced phone. */
const SIGN_UP = {
  firstName: '  Layla ',
  lastName: 'Haddad',
  password: PASSWORD,
  dateOfBirth: '1991-03-09',
  nationality: 'Lebanese',
  phone: '+961 70 123 456',
  country: 'Lebanon',
  city: '  Beirut ',
  address: 'Hamra   Street, Building 12',
  postalCode: 'lb 1103',
};

/** The same person, as the profile stores them. */
const STORED = {
  firstName: 'Layla',
  lastName: 'Haddad',
  dateOfBirth: '1991-03-09',
  nationality: 'Lebanese',
  phone: '+96170123456',
  country: 'Lebanon',
  city: 'Beirut',
  address: 'Hamra Street, Building 12',
  postalCode: 'LB 1103',
};

let ctx: HttpTestContext;
let email: string;
let clientId: string;

async function profileRow(id = clientId) {
  const [row] = await ctx.db.db
    .select({
      firstName: users.firstName,
      lastName: users.lastName,
      dateOfBirth: users.dateOfBirth,
      nationality: users.nationality,
      phone: users.phone,
      country: users.country,
      city: users.city,
      address: users.address,
      postalCode: users.postalCode,
    })
    .from(users)
    .where(eq(users.id, id));
  return row;
}

async function setKycStatus(status: 'in_progress' | 'submitted' | 'under_review' | 'approved') {
  await ctx.db.db.update(kycSubmissions).set({ status }).where(eq(kycSubmissions.userId, clientId));
}

const register = (body: Record<string, unknown>) =>
  anonymous(ctx).post(REGISTER).set('Origin', ORIGIN).send(body);

beforeAll(async () => {
  ctx = await startHttpTestApp();
  const db = ctx.db.db;
  const passwords = new PasswordService();

  const [role] = await db
    .insert(roles)
    .values({ name: 'Single Home Master', permissions: ALL_PERMISSIONS, isSystem: true })
    .returning();
  await db.insert(admins).values({
    email: MASTER.email,
    passwordHash: await passwords.hash(MASTER.password),
    name: 'Single Home Master',
    role: 'master_admin',
    roleId: role.id,
    permissions: ALL_PERMISSIONS,
    status: 'active',
  });

  await db.insert(kycConfigSteps).values(
    DEFAULT_KYC_STEPS.map((step, idx) => ({
      id: step.id,
      stepNumber: idx + 1,
      slug: step.slug,
      title: step.title,
      description: step.description,
      icon: step.icon,
      enabled: step.enabled,
      fields: step.fields as unknown as Record<string, unknown>[],
    })),
  );

  email = `single-home-${Date.now()}@oxshare-e2e.test`;
  const res = await register({ ...SIGN_UP, email });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  const [row] = await db.select().from(users).where(eq(users.email, email));
  clientId = row.id;
  // Confirmed the way the emailed code would; the code flow has its own spec.
  await db.update(users).set({ emailVerified: true }).where(eq(users.id, clientId));
}, 180_000);

afterAll(async () => {
  await stopHttpTestApp(ctx);
});

describe('sign-up writes the profile — once, in its canonical shape', () => {
  it('stores what was typed, tidied: trimmed, one phone shape, the postcode upper-cased', async () => {
    expect(await profileRow()).toEqual(STORED);
  });

  it('refuses a wrong value FIELD BY FIELD, and creates nobody', async () => {
    const stranger = `single-home-refused-${Date.now()}@oxshare-e2e.test`;
    const res = await register({
      ...SIGN_UP,
      email: stranger,
      firstName: 't1',
      dateOfBirth: '2015-01-01',
      phone: '+961 70 12',
      nationality: 'Lebanon',
      country: 'LB',
      postalCode: '#',
    });
    expect(res.status).toBe(400);
    const fields = (res.body as { fields?: Record<string, string> }).fields ?? {};
    expect(Object.keys(fields).sort()).toEqual(
      ['country', 'dateOfBirth', 'firstName', 'nationality', 'phone', 'postalCode'].sort(),
    );
    expect(fields['dateOfBirth']).toMatch(/at least 18/);
    expect(fields['nationality']).toMatch(/nationality/i);
    const created = await ctx.db.db.select().from(users).where(eq(users.email, stranger));
    expect(created, 'a refused sign-up still created an account').toEqual([]);
  });

  it('answers a refused value identically whether or not the address holds an account', async () => {
    // Validated BEFORE the address is looked up, so a refusal says nothing
    // about who is registered — the enumeration the generic answer protects.
    const shape = (res: { status: number; body: unknown }) => {
      const { requestId: _r, timestamp: _t, ...rest } = res.body as Record<string, unknown>;
      return { status: res.status, ...rest };
    };
    const bad = { ...SIGN_UP, dateOfBirth: '2015-01-01' };
    const taken = await register({ ...bad, email });
    const fresh = await register({
      ...bad,
      email: `single-home-fresh-${Date.now()}@oxshare-e2e.test`,
    });
    expect(shape(taken)).toEqual(shape(fresh));
  });

  it('still registers a client who gives only a name — completeness is judged at KYC submission', async () => {
    const minimal = `single-home-minimal-${Date.now()}@oxshare-e2e.test`;
    const res = await register({
      firstName: 'Min',
      lastName: 'Imal',
      email: minimal,
      password: PASSWORD,
    });
    expect(res.status).toBe(201);
  });
});

describe('the KYC form opens on the profile — nothing typed twice', () => {
  it('pre-fills every profile field the personal step asks for, exactly as stored', async () => {
    const client = await actingAs(ctx, 'portal', { email, password: PASSWORD });
    const res = await client.get('/v1/kyc/status').expect(200);
    expect((res.body as { personalInfo?: Record<string, string> }).personalInfo).toEqual(STORED);
  });
});

describe('one record, whoever changes it', () => {
  it('a KYC edit IS the account edit — the account, the desk and the review all see it', async () => {
    const client = await actingAs(ctx, 'portal', { email, password: PASSWORD });
    await client
      .post('/v1/kyc/step', { step: 'personal', data: { ...STORED, city: 'Jounieh' } })
      .expect(201);

    expect((await profileRow()).city).toBe('Jounieh');
    const me = await client.get('/v1/auth/me').expect(200);
    expect(JSON.stringify(me.body)).toContain('Jounieh');

    const desk = await actingAs(ctx, 'admin', MASTER);
    const detail = await desk.get(`/v1/admin/clients/${clientId}`).expect(200);
    expect(JSON.stringify(detail.body)).toContain('Jounieh');
    const review = await desk.get(`/v1/admin/kyc/${clientId}`).expect(200);
    expect((review.body as { personalInfo?: Record<string, string> }).personalInfo?.city).toBe(
      'Jounieh',
    );

    // The submission holds no copy of it.
    const [submission] = await ctx.db.db
      .select({ personalInfo: kycSubmissions.personalInfo })
      .from(kycSubmissions)
      .where(eq(kycSubmissions.userId, clientId));
    expect(submission.personalInfo).toEqual({});
  });

  it('audits the KYC edit — what moved, before and after, and from where', async () => {
    const rows = await ctx.db.db
      .select({ details: auditLog.details, actorKind: auditLog.actorKind })
      .from(auditLog)
      .where(and(eq(auditLog.action, 'client.profile_update'), eq(auditLog.subjectId, clientId)));
    const kyc = rows.find((r) => (r.details as { via?: string })?.via === 'kyc');
    expect(kyc, 'the KYC edit left no audit row').toBeDefined();
    expect(kyc?.actorKind).toBe('client');
    expect(kyc?.details).toEqual({
      before: { city: 'Beirut' },
      after: { city: 'Jounieh' },
      via: 'kyc',
    });
  });

  it('a desk edit IS what the client’s KYC form shows next', async () => {
    const desk = await actingAs(ctx, 'admin', MASTER);
    await desk.patch(`/v1/admin/clients/${clientId}`, { phone: '+961 71 000 111' }).expect(200);

    const client = await actingAs(ctx, 'portal', { email, password: PASSWORD });
    const status = await client.get('/v1/kyc/status').expect(200);
    expect((status.body as { personalInfo?: Record<string, string> }).personalInfo?.phone).toBe(
      '+96171000111',
    );
  });

  it('holds the desk to the same rules as the client, field by field', async () => {
    const desk = await actingAs(ctx, 'admin', MASTER);
    const res = await desk.patch(`/v1/admin/clients/${clientId}`, {
      firstName: 'L4yla',
      country: 'Atlantis',
    });
    expect(res.status).toBe(400);
    expect(Object.keys((res.body as { fields?: object }).fields ?? {}).sort()).toEqual([
      'country',
      'firstName',
    ]);
    expect((await profileRow()).firstName).toBe('Layla');
  });
});

describe('what a reviewer is checking cannot move under them', () => {
  it('once SUBMITTED: the desk may change the phone, and nothing else', async () => {
    await setKycStatus('submitted');
    try {
      const desk = await actingAs(ctx, 'admin', MASTER);
      const rename = await desk.patch(`/v1/admin/clients/${clientId}`, { firstName: 'Leila' });
      expect(rename.status).toBe(409);
      expect((rename.body as { code?: string }).code).toBe('PROFILE_LOCKED');
      expect((rename.body as { fields?: Record<string, string> }).fields?.['firstName']).toMatch(
        /checked against the client's documents/,
      );
      expect((await profileRow()).firstName).toBe('Layla');

      await desk.patch(`/v1/admin/clients/${clientId}`, { phone: '+961 71 000 222' }).expect(200);

      // …and an unchanged value sent back with it is no edit at all.
      await desk
        .patch(`/v1/admin/clients/${clientId}`, { firstName: 'Layla', phone: '+961 71 000 333' })
        .expect(200);

      const client = await actingAs(ctx, 'portal', { email, password: PASSWORD });
      await client
        .post('/v1/kyc/step', { step: 'personal', data: { firstName: 'Leila' } })
        .expect(403);
    } finally {
      await setKycStatus('in_progress');
    }
  });

  it('once APPROVED: the date of birth goes to the correction, a name to a new verification', async () => {
    await setKycStatus('approved');
    try {
      const desk = await actingAs(ctx, 'admin', MASTER);
      const dob = await desk.patch(`/v1/admin/clients/${clientId}`, { dateOfBirth: '1991-03-19' });
      expect(dob.status).toBe(409);
      expect((dob.body as { fields?: Record<string, string> }).fields?.['dateOfBirth']).toMatch(
        /KYC review/,
      );
      const name = await desk.patch(`/v1/admin/clients/${clientId}`, { nationality: 'Syrian' });
      expect((name.body as { fields?: Record<string, string> }).fields?.['nationality']).toMatch(
        /new verification/,
      );

      // The correction route is the door — re-checked and audited on the verification.
      await desk
        .patch(`/v1/admin/kyc/${clientId}/personal-info`, { dateOfBirth: '1991-03-19' })
        .expect(200);
      expect((await profileRow()).dateOfBirth).toBe('1991-03-19');
    } finally {
      await setKycStatus('in_progress');
    }
  });

  it('tells the desk which fields are locked BEFORE it types into one', async () => {
    const desk = await actingAs(ctx, 'admin', MASTER);
    const locked = async () =>
      (
        (await desk.get(`/v1/admin/clients/${clientId}`).expect(200)).body as {
          lockedFields?: Record<string, string>;
        }
      ).lockedFields;

    expect(await locked()).toEqual({});
    await setKycStatus('submitted');
    try {
      const fields = await locked();
      expect(Object.keys(fields ?? {}).sort()).toEqual(
        [
          'address',
          'city',
          'country',
          'dateOfBirth',
          'firstName',
          'lastName',
          'nationality',
          'postalCode',
        ].sort(),
      );
      expect(fields?.['phone']).toBeUndefined();
    } finally {
      await setKycStatus('in_progress');
    }
  });

  it('decides by the state it finds UNDER THE LOCK, not the one it read first', async () => {
    /*
     * A submission and a desk edit racing: the edit starts while the KYC row is
     * held — as `submit` holds it from judging to `submitted` — and must wait,
     * then decide by what it finds. Deciding by a status read before the lock
     * is how a name changes under a reviewer who is holding the passport.
     */
    const held = await ctx.db.pool.connect();
    try {
      await held.query('BEGIN');
      await held.query('SELECT 1 FROM kyc_submissions WHERE user_id = $1 FOR UPDATE', [clientId]);

      const desk = await actingAs(ctx, 'admin', MASTER);
      let settled = false;
      const edit = desk
        .patch(`/v1/admin/clients/${clientId}`, { firstName: 'Leila' })
        .then((res) => {
          settled = true;
          return res;
        });

      await new Promise((resolve) => setTimeout(resolve, 400));
      expect(settled, 'the edit did not wait for the KYC row').toBe(false);

      await held.query("UPDATE kyc_submissions SET status = 'submitted' WHERE user_id = $1", [
        clientId,
      ]);
      await held.query('COMMIT');

      const res = await edit;
      expect(res.status, 'the edit decided by a status read before the lock').toBe(409);
      expect((await profileRow()).firstName).toBe('Layla');
    } finally {
      held.release();
      await setKycStatus('in_progress');
    }
  });
});

describe('there is no second write path', () => {
  it('refuses a profile field through the general user update, whatever the type says', async () => {
    const store = new UsersStore(ctx.db.db);
    const before = await profileRow();
    await expect(store.update(clientId, { firstName: 'Smuggled' } as never)).rejects.toThrow(
      /cannot write the client profile/,
    );
    expect(await profileRow()).toEqual(before);
  });
});

describe('GET /profile/options — the one list, for a screen with no session', () => {
  it('serves the lists the profile accepts, to anybody', async () => {
    const res = await anonymous(ctx).get('/v1/profile/options').expect(200);
    const body = res.body as { countries: string[]; nationalities: string[] };
    expect(body.countries).toEqual(KYC_COUNTRY_OPTIONS);
    expect(body.nationalities).toEqual(KYC_NATIONALITY_OPTIONS);
    expect(body.countries).not.toContain('Israel');
  });
});
