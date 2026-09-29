import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHash, randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { ALL_PERMISSIONS } from './support/all-permissions';
import {
  actingAs,
  startHttpTestApp,
  stopHttpTestApp,
  type HttpTestContext,
  type Session,
} from './http-setup';
import { KYC_TEST_PNG, uploadKycFile, uploadStandardKycDocuments } from './support/kyc-upload';
import { PasswordService } from '../src/common/security/password.service';
import { STORAGE_DRIVER, type StorageDriver } from '../src/common/uploads/storage/storage-driver';
import { admins, kycConfigSteps, roles, users } from '../src/database/schema';
import { DEFAULT_KYC_STEPS } from '../src/store/kyc-config.store';

/**
 * WHOSE IS THIS FILE? THE CLIENT'S IDENTITY RECORD SAYS (identity-core plan,
 * slice 6).
 *
 * `GET /uploads/kyc/:file` resolves the owner from the record's pages (0151)
 * for EVERY reader. Two defects that answered differently before:
 *
 *  - an UNRESTRICTED admin skipped the owner lookup, and was handed ANY file in
 *    the documents bucket by name — an orphan included;
 *  - a client lost access to their own documents the moment they reset their
 *    KYC: ownership was read from the live KYC row, and a reset deletes it,
 *    while what they had presented stays on record as evidence.
 *
 * Plus the spelling: the KYC columns have held `/uploads/kyc/x`, `./uploads/…`
 * and more over the years; the record keeps one (`uploads/kyc/<name>`), so a
 * document stored under any of them is still its owner's.
 */

const ADMIN = { email: 'file-owner-admin@oxshare.com', password: 'admin-password-123' };
const OWNER = { email: 'file-owner@oxshare-e2e.test', password: 'client-password-123' };
const OTHER = { email: 'file-other@oxshare-e2e.test', password: 'client-password-123' };
const PROFILE = {
  firstName: 'Layla',
  lastName: 'Haddad',
  dateOfBirth: '1990-01-01',
  phone: '+96170123456',
  nationality: 'Lebanese',
  country: 'Lebanon',
  address: 'Hamra Street 12',
  city: 'Beirut',
};

let ctx: HttpTestContext;
let ownerId: number;
let otherId: number;
let owner: Session;
let other: Session;
let admin: Session;
/** Objects this file put into storage by hand, removed afterwards. */
const planted: string[] = [];

async function one<T>(query: ReturnType<typeof sql>): Promise<T> {
  return (await ctx.db.db.execute(query)).rows[0] as T;
}

const storage = () => ctx.app.get<StorageDriver>(STORAGE_DRIVER);

async function plant(name: string): Promise<void> {
  await storage().put(`kyc/${name}`, KYC_TEST_PNG, {
    contentType: 'image/png',
    sha256: createHash('sha256').update(KYC_TEST_PNG).digest('hex'),
  });
  planted.push(`kyc/${name}`);
}

/** The stored name of the owner's current identity-document front page. */
async function currentFront(): Promise<string> {
  const row = await one<{ path: string }>(sql`
    SELECT document->>'frontFilePath' AS path FROM kyc_submissions WHERE user_id = ${ownerId}::integer`);
  return row.path.split('/').pop()!;
}

const read = (session: Session, name: string) => session.get(`/v1/uploads/kyc/${name}`);

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
    .values({ name: 'File Owner Master', permissions: ALL_PERMISSIONS, isSystem: true })
    .returning();
  await ctx.db.db.insert(admins).values({
    email: ADMIN.email,
    passwordHash: await passwords.hash(ADMIN.password),
    name: 'File Owner Admin',
    role: 'master_admin',
    roleId: role.id,
    permissions: ALL_PERMISSIONS,
  });
  for (const account of [OWNER, OTHER]) {
    const [user] = await ctx.db.db
      .insert(users)
      .values({
        email: account.email,
        passwordHash: await passwords.hash(account.password),
        emailVerified: true,
        ...PROFILE,
      })
      .returning();
    if (account === OWNER) ownerId = user.id;
    else otherId = user.id;
  }
  owner = await actingAs(ctx, 'portal', OWNER);
  other = await actingAs(ctx, 'portal', OTHER);
  admin = await actingAs(ctx, 'admin', ADMIN);
}, 180_000);

afterAll(async () => {
  for (const key of planted) await storage().delete(key);
  await stopHttpTestApp(ctx);
});

describe('GET /uploads/kyc/:file — the owner comes from the record', () => {
  let presented: string;

  it('serves the client the document they are working on — and nobody else', async () => {
    await uploadStandardKycDocuments(owner);
    presented = await currentFront();

    expect((await read(owner, presented)).status).toBe(200);
    expect((await read(admin, presented)).status).toBe(200);
    expect((await read(other, presented)).status).toBe(403);
  });

  it('after a return AND a reset, the client can still open what they presented', async () => {
    expect((await owner.post('/v1/kyc/submit', {})).status).toBeLessThan(300);
    expect((await admin.patch(`/v1/admin/kyc/${ownerId}/claim`, {})).status).toBeLessThan(300);
    const returned = await admin.patch(`/v1/admin/kyc/${ownerId}/reject`, {
      reason: 'The photo page is blurred',
      rejectedFields: ['doc_front'],
    });
    expect(returned.status, JSON.stringify(returned.body)).toBeLessThan(300);
    expect((await owner.post('/v1/kyc/reset', {})).status).toBeLessThan(300);

    // The live row is gone; the returned version is on the client's record.
    const live = await one<{ n: number }>(sql`
      SELECT count(*)::int AS n FROM kyc_submissions WHERE user_id = ${ownerId}::integer`);
    expect(live.n).toBe(0);
    expect((await read(owner, presented)).status).toBe(200);
    expect((await read(admin, presented)).status).toBe(200);
    expect((await read(other, presented)).status).toBe(403);
  });

  it('a new upload after the reset is theirs too', async () => {
    expect((await uploadKycFile(owner, 'doc_front', 'passport')).status).toBeLessThan(300);
    const fresh = await currentFront();
    expect(fresh).not.toBe(presented);
    expect((await read(owner, fresh)).status).toBe(200);
  });

  it('refuses EVERY reader an orphan — the unrestricted admin included', async () => {
    const orphan = `${randomUUID()}.png`;
    await plant(orphan);

    // The bytes are there; no client's record holds them.
    expect((await read(admin, orphan)).status).toBe(404);
    expect((await read(owner, orphan)).status).toBe(403);
    // Refused reads write no access row claiming the document was viewed.
    const views = await one<{ n: number }>(sql`
      SELECT count(*)::int AS n FROM audit_log
       WHERE action = 'kyc.document.view' AND subject_id = ${orphan}`);
    expect(views.n).toBe(0);
  });

  it('finds the owner of a document stored under an old spelling of its path', async () => {
    const legacy = `${randomUUID()}.png`;
    await plant(legacy);
    // Written as the KYC columns once held it: a leading slash.
    await ctx.db.db.execute(sql`
      INSERT INTO kyc_submission_attempts (user_id, attempt_no, status, document, archived_at)
      VALUES (${ownerId}::integer, 99, 'rejected',
              ${JSON.stringify({ docType: 'passport', frontFilePath: `/uploads/kyc/${legacy}` })}::jsonb,
              now())`);

    expect((await read(owner, legacy)).status).toBe(200);
    expect((await read(admin, legacy)).status).toBe(200);
    expect((await read(other, legacy)).status).toBe(403);
  });

  it('serves a file TWO clients’ records claim to nobody, rather than guess whose it is', async () => {
    // A data error — a file is never shared — and the one answer that cannot
    // hand one client's passport to another is "neither".
    const shared = `${randomUUID()}.png`;
    await plant(shared);
    for (const [user, no] of [
      [ownerId, 100],
      [otherId, 1],
    ] as const) {
      await ctx.db.db.execute(sql`
        INSERT INTO kyc_submission_attempts (user_id, attempt_no, status, document, archived_at)
        VALUES (${user}::integer, ${no}, 'rejected',
                ${JSON.stringify({ docType: 'passport', frontFilePath: `uploads/kyc/${shared}` })}::jsonb,
                now())`);
    }

    expect((await read(admin, shared)).status).toBe(404);
    expect((await read(owner, shared)).status).toBe(403);
    expect((await read(other, shared)).status).toBe(403);
  });
});
