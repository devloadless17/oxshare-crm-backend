import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ALL_PERMISSIONS } from './support/all-permissions';
import {
  actingAs,
  startHttpTestApp,
  stopHttpTestApp,
  type HttpTestContext,
  type Session,
} from './http-setup';
import { uploadKycFile } from './support/kyc-upload';
import { PasswordService } from '../src/common/security/password.service';
import { admins, kycConfigSteps, roles, users } from '../src/database/schema';
import { DEFAULT_KYC_STEPS } from '../src/store/kyc-config.store';

/**
 * THE KYC FORM IS THE BROKER'S (Phase 2, 29 Sep 2026). What the owner asked for,
 * driven through the real API:
 *
 *  - identity details taken out of KYC (sign-up has them) and the selfie made
 *    optional: a client submits without them;
 *  - the form TIGHTENED after the client submitted: approval still goes
 *    through — it re-checks the requirements the submission was made under;
 *  - a question moved to another step keeps the answer already given.
 */

const ADMIN = { email: 'form-admin@oxshare.com', password: 'admin-password-123' };
const CLIENT = { email: 'form-client@oxshare-e2e.test', password: 'client-password-123' };

type Field = { name: string; required: boolean; [key: string]: unknown };
type Step = { slug: string; enabled: boolean; evidenceRequired?: boolean; fields: Field[] };

let ctx: HttpTestContext;
let admin: Session;
let client: Session;
let clientId: number;

const readForm = async () => (await admin.get('/v1/admin/kyc-config')).body as Step[];
const saveForm = async (steps: Step[]) => {
  const res = await admin.put('/v1/admin/kyc-config', { format: 2, steps });
  expect(res.status, JSON.stringify(res.body).slice(0, 300)).toBe(200);
};
const ok = (res: { status: number; body: unknown }) =>
  expect(res.status, JSON.stringify(res.body).slice(0, 300)).toBeLessThan(300);

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
  const [role] = await ctx.db.db
    .insert(roles)
    .values({ name: 'Form Master', permissions: ALL_PERMISSIONS, isSystem: true })
    .returning();
  await ctx.db.db.insert(admins).values({
    email: ADMIN.email,
    passwordHash: await passwords.hash(ADMIN.password),
    name: 'Form Admin',
    role: 'master_admin',
    roleId: role.id,
    permissions: ALL_PERMISSIONS,
  });
  // Signed up with the sign-up details only: no address, no city.
  const [user] = await ctx.db.db
    .insert(users)
    .values({
      email: CLIENT.email,
      passwordHash: await passwords.hash(CLIENT.password),
      emailVerified: true,
      firstName: 'Layla',
      lastName: 'Haddad',
      dateOfBirth: '1990-01-01',
      phone: '+96170123456',
      nationality: 'Lebanese',
      country: 'Lebanon',
    })
    .returning();
  clientId = user.id;
  admin = await actingAs(ctx, 'admin', ADMIN);
  client = await actingAs(ctx, 'portal', CLIENT);
}, 180_000);

afterAll(async () => {
  await stopHttpTestApp(ctx);
});

describe('a form arranged by the broker', () => {
  it('lets a client submit without the details taken out, and without an optional selfie', async () => {
    const form = await readForm();
    await saveForm(
      form.map((step) =>
        step.slug === 'personal'
          ? {
              ...step,
              fields: step.fields.filter((f) => f.name !== 'address' && f.name !== 'city'),
            }
          : step.slug === 'selfie'
            ? { ...step, evidenceRequired: false }
            : step.slug === 'address'
              ? { ...step, enabled: false }
              : step,
      ),
    );
    ok(await uploadKycFile(client, 'doc_front', 'passport'));
    ok(await client.post('/v1/kyc/submit', {}));
  });

  it('approves it after the form is TIGHTENED — the submission is judged as it was made', async () => {
    const form = await readForm();
    await saveForm(
      form.map((step) => (step.slug === 'selfie' ? { ...step, evidenceRequired: true } : step)),
    );
    ok(await admin.patch(`/v1/admin/kyc/${clientId}/claim`, {}));
    ok(await admin.patch(`/v1/admin/kyc/${clientId}/approve`, {}));
  });

  it('keeps an answer when its question moves to another step', async () => {
    // A question of the broker's on a step of their own, answered…
    const form = await readForm();
    const question = {
      id: 'f-occupation',
      name: 'customField_occupation',
      label: 'Occupation',
      type: 'text',
      required: true,
    };
    await saveForm([
      ...form,
      { slug: 'about-you', title: 'About you', enabled: true, fields: [question] } as Step,
    ]);
    ok(
      await admin.post(`/v1/admin/kyc/${clientId}/reverify`, {
        reason: 'Update',
        items: ['firstName'],
      }),
    );
    ok(
      await client.post('/v1/kyc/step', {
        step: 'about-you',
        data: { customField_occupation: 'Pilot' },
      }),
    );

    // …then moved onto Personal Information.
    const moved = (await readForm()).map((step) =>
      step.slug === 'about-you'
        ? { ...step, fields: [] }
        : step.slug === 'personal'
          ? { ...step, fields: [...step.fields, question] }
          : step,
    );
    await saveForm(moved);

    const status = (await client.get('/v1/kyc/status')).body as {
      personalInfo?: Record<string, unknown>;
      steps: { slug: string; missing: { id: string }[] }[];
    };
    expect(status.personalInfo?.['customField_occupation']).toBe('Pilot');
    const personal = status.steps.find((step) => step.slug === 'personal');
    expect(personal?.missing.map((item) => item.id)).not.toContain('customField_occupation');
  });
});
