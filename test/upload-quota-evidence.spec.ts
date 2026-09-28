import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startMoneyTestDb, stopMoneyTestDb, type MoneyTestContext } from './money-setup';
import { StoredObjectsStore } from '../src/store/stored-objects.store';

/**
 * THE UPLOAD ALLOWANCE COUNTS WHAT A CLIENT CAN REMOVE — never their evidence
 * (identity-core plan, slice 6).
 *
 * A page of a FROZEN version of the client's identity record is something they
 * presented for review; the record keeps it for ever and nobody can delete it.
 * Counting it meant every round of KYC permanently shrank the room for the
 * next, with nothing the client could remove to make space. What still counts:
 * drafts, files no version holds, other buckets. Against real Postgres, because
 * the rule is a join the unit stubs cannot see.
 */

let ctx: MoneyTestContext;
let store: StoredObjectsStore;

async function q<T = Record<string, unknown>>(text: string, values: unknown[] = []): Promise<T[]> {
  return (await ctx.pool.query(text, values)).rows as T[];
}

async function client(name: string): Promise<string> {
  const [row] = await q<{ id: string }>(
    `INSERT INTO users (email, password_hash, first_name, last_name, email_verified)
     VALUES ($1, 'x', 'Layla', 'Haddad', true) RETURNING id`,
    [`quota-${name}@example.com`],
  );
  return row.id;
}

/** One object in the registry, as an upload writes it. */
async function stored(owner: string, key: string, bytes: number, deleted = false) {
  await q(
    `INSERT INTO stored_objects (bucket, storage_key, provider, content_type, byte_size, sha256,
                                 owner_user_id, uploaded_by_id, uploaded_by_kind, deleted_at)
     VALUES ($1, $2, 'disk', 'image/png', $3, repeat('a', 64), $4, $4, 'client', $5)`,
    [key.split('/')[0], key, bytes, owner, deleted ? new Date() : null],
  );
}

/** A version of `owner`'s record holding `key` as its one page. */
async function version(owner: string, slot: string, key: string, frozen: boolean) {
  const [doc] = await q<{ id: string }>(
    `INSERT INTO client_documents (user_id, slot) VALUES ($1, $2) RETURNING id`,
    [owner, slot],
  );
  await q(`INSERT INTO client_document_pages (document_id, part, storage_key) VALUES ($1, 0, $2)`, [
    doc.id,
    `uploads/${key}`,
  ]);
  if (frozen) await q(`UPDATE client_documents SET frozen_at = now() WHERE id = $1`, [doc.id]);
}

beforeAll(async () => {
  ctx = await startMoneyTestDb();
  store = new StoredObjectsStore(ctx.db);
}, 180_000);

afterAll(async () => {
  await stopMoneyTestDb(ctx);
});

describe('the upload allowance', () => {
  it('counts drafts, unreferenced files and other buckets — never evidence', async () => {
    const layla = await client('layla');
    const omar = await client('omar');

    await stored(layla, 'kyc/presented.png', 1_000); // evidence: a frozen page
    await version(layla, 'identity', 'kyc/presented.png', true);
    await stored(layla, 'kyc/draft.png', 2_000); // a draft page: still removable
    await version(layla, 'selfie', 'kyc/draft.png', false);
    await stored(layla, 'kyc/loose.png', 4_000); // held by no version of HERS…
    await version(omar, 'identity', 'kyc/loose.png', true); // …only by somebody else's
    await stored(layla, 'avatars/me.png', 8_000); // another bucket
    await stored(layla, 'kyc/gone.png', 16_000, true); // already deleted

    expect(await store.liveBytesForOwner(layla)).toBe(2_000 + 4_000 + 8_000);
  });

  it('frees the room the moment a client presents what they uploaded', async () => {
    const nadia = await client('nadia');
    await stored(nadia, 'kyc/n-front.png', 9_000_000);
    await version(nadia, 'identity', 'kyc/n-front.png', false);
    expect(await store.liveBytesForOwner(nadia)).toBe(9_000_000);

    // Submitted: the draft is frozen — evidence now, and nobody's to remove.
    await q(
      `UPDATE client_documents SET frozen_at = now() WHERE user_id = $1 AND frozen_at IS NULL`,
      [nadia],
    );
    expect(await store.liveBytesForOwner(nadia)).toBe(0);
  });
});
