import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { ALL_PERMISSIONS } from './support/all-permissions';
import { actingAs, startHttpTestApp, stopHttpTestApp, type HttpTestContext } from './http-setup';
import { PasswordService } from '../src/common/security/password.service';
import { admins, roles } from '../src/database/schema';

/**
 * A client's DOCUMENTS tab (owner, 29 Sep 2026): `GET /admin/clients/:id/documents`.
 *
 * Every file the client handed the platform in one list — KYC document versions
 * and offline-deposit receipts — each with where it stands. Pinned here:
 *
 *  - a KYC version reads its review (a draft, awaiting review → pending), and an
 *    older version is marked not current;
 *  - a receipt reads its DEPOSIT: pending, credited → approved, refused →
 *    rejected WITH the reason — the owner's example;
 *  - each half needs the permission that guards its files, and a half withheld
 *    is NAMED in `hidden`, never shown as "none";
 *  - newest first, and the file paths open through the audited file routes.
 */

const MASTER = { email: 'docs-master@oxshare.com', password: 'admin-password-123' };
const RECEIPTS_ONLY = { email: 'docs-receipts@oxshare.com', password: 'admin-password-123' };
const CLIENTS_ONLY = { email: 'docs-clients@oxshare.com', password: 'admin-password-123' };

interface Doc {
  id: string;
  category: string;
  title: string;
  detail: string | null;
  status: string;
  current: boolean;
  files: { label: string; path: string }[];
  reason: string | null;
  transactionId: string | null;
  uploadedAt: string;
}
interface DocList {
  items: Doc[];
  hidden: string[];
}

let ctx: HttpTestContext;
let clientId: number;
const tx: Record<string, string> = {};
let oldPassport: string;
let newPassport: string;

beforeAll(async () => {
  ctx = await startHttpTestApp();
  const db = ctx.db.db;
  const passwords = new PasswordService();
  const admin = async (who: { email: string; password: string }, permissions: string[]) => {
    const [role] = await db.insert(roles).values({ name: who.email, permissions }).returning();
    await db.insert(admins).values({
      email: who.email,
      passwordHash: await passwords.hash(who.password),
      name: who.email,
      role: 'master_admin',
      roleId: role.id,
      permissions: ['*'],
      status: 'active',
    });
  };
  await admin(MASTER, ALL_PERMISSIONS);
  await admin(RECEIPTS_ONLY, ['clients.view', 'deposits.proofs.view']);
  await admin(CLIENTS_ONLY, ['clients.view']);

  const one = async <T>(query: ReturnType<typeof sql>) =>
    ((await db.execute(query)).rows as unknown as T[])[0];

  clientId = (
    await one<{ id: number }>(sql`
      INSERT INTO users (email, password_hash, first_name, last_name, email_verified)
      VALUES ('docs-client@oxshare-e2e.test', 'x', 'Rana', 'Docs', true) RETURNING id`)
  ).id;

  // KYC: an OLD passport presented days ago, then a NEW one still a draft. Pages
  // go in BEFORE a version is frozen — a presented document is immutable.
  const version = async (ago: string) =>
    (
      await one<{ id: string }>(sql`
        INSERT INTO client_documents (user_id, slot, doc_type, created_at)
        VALUES (${clientId}, 'identity', 'passport', now() - ${ago}::interval) RETURNING id`)
    ).id;
  const pageOf = (id: string) =>
    db.execute(sql`
      INSERT INTO client_document_pages (document_id, part, storage_key)
      VALUES (${id}, 0, ${`uploads/kyc/${id}.png`})`);
  // One draft per slot: the old one is presented (frozen) before the new one exists.
  oldPassport = await version('5 days');
  await pageOf(oldPassport);
  await db.execute(
    sql`UPDATE client_documents SET frozen_at = now() - interval '5 days' WHERE id = ${oldPassport}`,
  );
  newPassport = await version('1 day');
  await pageOf(newPassport);

  // Deposits with receipts, in three states — and one deposit with NO receipt.
  const walletId = (
    await one<{ id: string }>(sql`
      INSERT INTO wallets (user_id, currency) VALUES (${clientId}, 'USD') RETURNING id`)
  ).id;
  const deposit = async (
    key: string,
    state: string,
    proof: string | null,
    reason: string | null,
    ago: string,
  ) =>
    (tx[key] = (
      await one<{ id: string }>(sql`
        INSERT INTO transactions
          (user_id, wallet_id, direction, amount, currency, state, provider, proof_filename,
           rejection_reason, created_at)
        VALUES (${clientId}, ${walletId}, 'deposit', '150', 'USD', ${state}::transaction_state,
                'manual_bank', ${proof}, ${reason}, now() - ${ago}::interval)
        RETURNING id`)
    ).id);
  await deposit('pending', 'pending', 'aaaa1111.jpg', null, '3 hours');
  await deposit('credited', 'success', 'bbbb2222.pdf', null, '2 days');
  await deposit(
    'refused',
    'rejected',
    'cccc3333.png',
    'The receipt is for a different amount.',
    '4 days',
  );
  await deposit('noReceipt', 'success', null, null, '1 hour');
}, 240_000);

afterAll(async () => {
  await stopHttpTestApp(ctx);
});

const read = async (who: { email: string; password: string }) =>
  (
    await (
      await actingAs(ctx, 'admin', who)
    )
      .get(`/v1/admin/clients/${clientId}/documents`)
      .expect(200)
  ).body as DocList;

describe('GET /admin/clients/:id/documents', () => {
  it('lists KYC versions and deposit receipts together, newest first', async () => {
    const list = await read(MASTER);
    expect(list.hidden).toEqual([]);
    expect(list.items.map((d) => d.id)).toEqual([
      tx.pending, // 3 hours
      newPassport, // 1 day
      tx.credited, // 2 days
      tx.refused, // 4 days
      oldPassport, // 5 days
    ]);
    // A deposit with no receipt is not a document.
    expect(list.items.map((d) => d.id)).not.toContain(tx.noReceipt);
  });

  it('gives a receipt its DEPOSIT’s status — a refused deposit’s receipt is rejected, with why', async () => {
    const byId = new Map((await read(MASTER)).items.map((d) => [d.id, d]));
    expect(byId.get(tx.pending)).toMatchObject({ category: 'deposit_receipt', status: 'pending' });
    expect(byId.get(tx.credited)).toMatchObject({ status: 'approved', reason: null });
    expect(byId.get(tx.refused)).toMatchObject({
      status: 'rejected',
      reason: 'The receipt is for a different amount.',
      transactionId: tx.refused,
      files: [{ label: 'Receipt', path: 'uploads/deposit-proofs/cccc3333.png' }],
    });
    expect(byId.get(tx.credited)?.detail).toBe('150 USD');
  });

  it('gives a KYC version its review status, and marks the replaced one not current', async () => {
    const byId = new Map((await read(MASTER)).items.map((d) => [d.id, d]));
    expect(byId.get(newPassport)).toMatchObject({
      category: 'identity',
      title: 'Identity document',
      status: 'draft',
      current: true,
    });
    expect(byId.get(oldPassport)).toMatchObject({ status: 'pending', current: false });
    expect(byId.get(oldPassport)?.files[0].path).toBe(`uploads/kyc/${oldPassport}.png`);
  });

  it('withholds KYC from a reader without KYC document rights — and says so', async () => {
    const list = await read(RECEIPTS_ONLY);
    expect(list.items.every((d) => d.category === 'deposit_receipt')).toBe(true);
    expect(list.items).toHaveLength(3);
    expect(list.hidden).toEqual(['identity', 'address', 'selfie', 'kyc_other']);
  });

  it('withholds everything from a reader who may see neither, naming both halves', async () => {
    const list = await read(CLIENTS_ONLY);
    expect(list.items).toEqual([]);
    expect(list.hidden).toEqual(['identity', 'address', 'selfie', 'kyc_other', 'deposit_receipt']);
  });

  it('is 404 for a client that does not exist', async () => {
    const session = await actingAs(ctx, 'admin', MASTER);
    await session.get('/v1/admin/clients/99999999/documents').expect(404);
  });
});
