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
import { ClientIdentityService } from '../src/modules/client-identity/client-identity.service';
import { admins, kycConfigSteps, roles, users } from '../src/database/schema';
import { DEFAULT_KYC_STEPS } from '../src/store/kyc-config.store';

/**
 * EVIDENCE IS READ FROM THE CLIENT'S RECORD (identity-core plan, slice 6).
 *
 * The KYC columns are still written — the record is derived from them — but
 * every read of a submission's identity document, proof of address and selfie
 * now comes from the record (`identity_evidence`, 0152). Two ways to see it on
 * the wire:
 *
 *  - a path the columns hold in an old spelling is served in the record's one
 *    spelling, `uploads/kyc/<name>`;
 *  - a change made to the columns where the record could not follow (triggers
 *    off, as a restore runs) is NOT what the API shows — until the repair
 *    adopts it. That is the contract slice's premise: once reads are the
 *    record's, the columns can go.
 */

const ADMIN = { email: 'record-reads-admin@oxshare.com', password: 'admin-password-123' };
const CLIENT = { email: 'record-reads@oxshare-e2e.test', password: 'client-password-123' };

let ctx: HttpTestContext;
let client: Session;
let admin: Session;
let clientId: string;
const front = `${randomUUID()}.png`;
const replaced = `${randomUUID()}.png`;

type Status = { document?: { docType?: string; frontFilePath?: string; frontFileName?: string } };

async function withoutTriggers(query: ReturnType<typeof sql>): Promise<void> {
  await ctx.db.db.transaction(async (tx) => {
    await tx.execute(sql`SET LOCAL session_replication_role = replica`);
    await tx.execute(query);
  });
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
  // Written the way an old build once did: a leading `./`. The record adopts
  // it (0153) in its one spelling.
  await ctx.db.db.execute(sql`
    INSERT INTO kyc_submissions (user_id, status, document)
    VALUES (${clientId}::uuid, 'in_progress',
            ${JSON.stringify({ docType: 'passport', frontFilePath: `./uploads/kyc/${front}`, frontFileName: 'passport.png' })}::jsonb)`);
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
    expect((mine.body as Status).document).toEqual({
      docType: 'passport',
      frontFilePath: `uploads/kyc/${front}`,
      frontFileName: 'passport.png',
    });

    const review = await admin.get(`/v1/admin/kyc/${clientId}`);
    expect(review.status).toBe(200);
    expect((review.body as Status).document?.frontFilePath).toBe(`uploads/kyc/${front}`);
  });

  it('does NOT show a change the record could not follow — until the repair adopts it', async () => {
    await withoutTriggers(sql`
      UPDATE kyc_submissions
         SET document = jsonb_set(document, '{frontFilePath}', ${JSON.stringify(`uploads/kyc/${replaced}`)}::jsonb)
       WHERE user_id = ${clientId}::uuid`);

    const before = await client.get('/v1/kyc/status');
    expect((before.body as Status).document?.frontFilePath).toBe(`uploads/kyc/${front}`);

    await ctx.app.get(ClientIdentityService).repairDrift();

    const after = await client.get('/v1/kyc/status');
    expect((after.body as Status).document?.frontFilePath).toBe(`uploads/kyc/${replaced}`);
  });
});
