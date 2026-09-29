import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ALL_PERMISSIONS } from './support/all-permissions';
import {
  actingAs,
  startHttpTestApp,
  stopHttpTestApp,
  type HttpTestContext,
  type Session,
} from './http-setup';
import { uploadKycFile, uploadStandardKycDocuments } from './support/kyc-upload';
import { PasswordService } from '../src/common/security/password.service';
import { admins, kycConfigSteps, roles, users } from '../src/database/schema';
import { DEFAULT_KYC_STEPS } from '../src/store/kyc-config.store';

/**
 * GET /admin/clients/:id/identity — the client's identity record as the
 * console shows it (identity-core plan, slice 8): every version of every
 * document with its status READ FROM THE LOG, and every decision.
 */

const ADMIN = { email: 'identity-record-admin@oxshare.com', password: 'admin-password-123' };
const VIEWER = { email: 'identity-record-viewer@oxshare.com', password: 'admin-password-123' };
const CLIENT = { email: 'identity-record@oxshare-e2e.test', password: 'client-password-123' };

let ctx: HttpTestContext;
let admin: Session;
let viewer: Session;
let client: Session;
let clientId: number;

type IdentityRecordBody = {
  documents?: {
    slot: string;
    label: string;
    versions: { status: string; returnedPages: string[]; docLabel: string | null }[];
  }[];
  verifications?: { outcome: string; levelAfter: number; decidedBy: string | null }[];
};

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
  for (const [account, permissions, name] of [
    [ADMIN, ALL_PERMISSIONS, 'Identity Record Master'],
    [VIEWER, ['clients.view'], 'Identity Record Viewer'],
  ] as const) {
    const [role] = await ctx.db.db
      .insert(roles)
      .values({ name, permissions: [...permissions], isSystem: false })
      .returning();
    await ctx.db.db.insert(admins).values({
      email: account.email,
      passwordHash: await passwords.hash(account.password),
      name,
      role: 'sub_admin',
      roleId: role.id,
      permissions: [...permissions],
    });
  }
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
      address: 'Hamra Street 12',
      city: 'Beirut',
    })
    .returning();
  clientId = user.id;
  client = await actingAs(ctx, 'portal', CLIENT);
  admin = await actingAs(ctx, 'admin', ADMIN);
  viewer = await actingAs(ctx, 'admin', VIEWER);
}, 180_000);

afterAll(async () => {
  await stopHttpTestApp(ctx);
});

describe('the client’s identity record', () => {
  it('shows every version with its status from the log, and every decision', async () => {
    const ok = (res: { status: number; body: unknown }) =>
      expect(res.status, JSON.stringify(res.body)).toBeLessThan(300);
    await uploadStandardKycDocuments(client);
    ok(await client.post('/v1/kyc/submit', {}));
    ok(await admin.patch(`/v1/admin/kyc/${clientId}/claim`, {}));
    ok(
      await admin.patch(`/v1/admin/kyc/${clientId}/reject`, {
        reason: 'The photo page is blurred',
        rejectedFields: ['doc_front'],
      }),
    );
    ok(await uploadKycFile(client, 'doc_front', 'passport'));
    ok(await client.post('/v1/kyc/submit', {}));
    ok(await admin.patch(`/v1/admin/kyc/${clientId}/claim`, {}));
    ok(await admin.patch(`/v1/admin/kyc/${clientId}/approve`, {}));

    const res = await admin.get(`/v1/admin/clients/${clientId}/identity`);
    expect(res.status).toBe(200);
    const record = res.body as IdentityRecordBody;

    const identity = record.documents?.find((d) => d.slot === 'identity');
    expect(identity?.label).toBe('Identity document');
    // Newest first: the passport that passed, then the one returned for its photo page.
    expect(identity?.versions.map((v) => [v.status, v.returnedPages, v.docLabel])).toEqual([
      ['verified', [], 'Passport'],
      ['returned', ['doc_front'], 'Passport'],
    ]);
    expect(record.documents?.map((d) => d.slot)).toEqual(['identity', 'address', 'selfie']);
    expect(record.verifications?.map((v) => [v.outcome, v.levelAfter, v.decidedBy])).toEqual([
      ['verified', 1, ADMIN.email],
      ['returned', 0, ADMIN.email],
    ]);
  });

  it('leaves out — rather than empties — what the reader may not see', async () => {
    const res = await viewer.get(`/v1/admin/clients/${clientId}/identity`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({});
  });
});
