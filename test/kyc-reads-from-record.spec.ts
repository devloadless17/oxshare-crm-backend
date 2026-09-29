import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { ALL_PERMISSIONS } from './support/all-permissions';
import {
  actingAs,
  startHttpTestApp,
  stopHttpTestApp,
  type HttpTestContext,
  type Session,
} from './http-setup';
import { PasswordService } from '../src/common/security/password.service';
import { recordKycEvidence } from './support/kyc-evidence';
import { admins, kycConfigSteps, roles, users } from '../src/database/schema';
import { DEFAULT_KYC_STEPS } from '../src/store/kyc-config.store';

/**
 * EVIDENCE IS READ FROM THE CLIENT'S RECORD — the only place it lives (0171).
 *
 * Every read of a submission's identity document, proof of address and selfie
 * comes from the record (`identity_evidence`, 0152), and a path handed to it in
 * an old spelling is served in the record's one spelling, `uploads/kyc/<name>`.
 */

const ADMIN = { email: 'record-reads-admin@oxshare.com', password: 'admin-password-123' };
const CLIENT = { email: 'record-reads@oxshare-e2e.test', password: 'client-password-123' };

let ctx: HttpTestContext;
let client: Session;
let admin: Session;
let clientId: number;
const front = `${randomUUID()}.png`;

type Status = { document?: Record<string, string> };

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
    .values({ name: 'Record Reads Master', permissions: ALL_PERMISSIONS, isSystem: true })
    .returning();
  await ctx.db.db.insert(admins).values({
    email: ADMIN.email,
    passwordHash: await passwords.hash(ADMIN.password),
    name: 'Record Reads Admin',
    role: 'master_admin',
    roleId: role.id,
    permissions: ALL_PERMISSIONS,
  });
  const [user] = await ctx.db.db
    .insert(users)
    .values({
      email: CLIENT.email,
      passwordHash: await passwords.hash(CLIENT.password),
      emailVerified: true,
      firstName: 'Layla',
      lastName: 'Haddad',
    })
    .returning();
  clientId = user.id;
  // Handed over the way an old build once wrote it: a leading `./`. The record
  // keeps it in its one spelling.
  await ctx.db.db.execute(sql`
    INSERT INTO kyc_submissions (user_id, status) VALUES (${clientId}::integer, 'in_progress')`);
  await recordKycEvidence(ctx.db.db, clientId, {
    document: { docType: 'passport', frontFilePath: `./uploads/kyc/${front}` },
  });
  client = await actingAs(ctx, 'portal', CLIENT);
  admin = await actingAs(ctx, 'admin', ADMIN);
}, 180_000);

afterAll(async () => {
  await stopHttpTestApp(ctx);
});

describe('a submission’s evidence, as the API reads it', () => {
  it('comes back in the record’s one spelling — to the client and to the reviewer', async () => {
    const mine = await client.get('/v1/kyc/status');
    expect(mine.status).toBe(200);
    // The path and the type — and no filename, which is not kept (0160, D-84).
    expect((mine.body as Status).document).toEqual({
      docType: 'passport',
      frontFilePath: `uploads/kyc/${front}`,
    });

    const review = await admin.get(`/v1/admin/kyc/${clientId}`);
    expect(review.status).toBe(200);
    expect((review.body as Status).document?.frontFilePath).toBe(`uploads/kyc/${front}`);
  });
});
