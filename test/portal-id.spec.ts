import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { sql } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import { startMoneyTestDb, stopMoneyTestDb, type MoneyTestContext } from './money-setup';
import { users } from '../src/database/schema';
import { clientIdentitySearch, parsePortalId, UsersStore } from '../src/store/users.store';

/**
 * THE PORTAL ID — the number staff and clients know an account by (0133).
 *
 * The client's previous platform numbered clients 1 to roughly 200,000, and
 * those clients are to be imported under their old numbers. So the column has
 * two sources and one rule between them:
 *
 *   - the SEQUENCE numbers every client this platform creates, from 1,000,000;
 *   - an IMPORT writes the old number explicitly, always below 1,000,000;
 *   - a unique index means the two can never hand out the same number.
 *
 * The uuid stays the primary key and every foreign key — the Portal ID is a
 * label, never an address (and never an access key: it is sequential, so it is
 * guessable by design).
 *
 * These cases pin the properties a client, an importer and every search box
 * rely on. Each one is a thing that would fail quietly if it were wrong: a
 * duplicate number shows two people as one, a number from the wrong range
 * collides with an import that has not happened yet, and a search that treats
 * digits as text finds every email containing them.
 */

let ctx: MoneyTestContext;
let store: UsersStore;

async function newClient(tag: string) {
  return store.create({
    email: `portal-${tag}-${Date.now()}@oxshare-e2e.test`,
    passwordHash: 'x',
    firstName: 'Portal',
    lastName: tag,
    status: 'active',
    emailVerified: true,
    verificationLevel: 0,
    type: 'individual',
  });
}

/** Insert a raw row, the way an importer would — the old number set explicitly. */
async function importClient(portalId: number | null) {
  return ctx.db.execute(sql`
    INSERT INTO users (email, password_hash, first_name, last_name, portal_id)
    VALUES (${`import-${portalId}-${Math.random()}@oxshare-e2e.test`}, 'x', 'Old', 'Platform', ${portalId})
  `);
}

/** The Postgres error code a failed statement carries, wherever drizzle put it. */
async function pgCode(run: () => Promise<unknown>): Promise<string | undefined> {
  try {
    await run();
  } catch (error) {
    const e = error as { code?: string; cause?: { code?: string } };
    return e.code ?? e.cause?.code;
  }
  return undefined;
}

beforeAll(async () => {
  ctx = await startMoneyTestDb();
  store = new UsersStore(ctx.db);
}, 300_000);

afterAll(async () => {
  await stopMoneyTestDb(ctx);
});

describe('a client this platform creates is numbered from 1,000,000', () => {
  it('assigns a Portal ID nobody passed in', async () => {
    const client = await newClient('first');
    expect(Number.isInteger(client.portalId)).toBe(true);
    expect(client.portalId).toBeGreaterThanOrEqual(1_000_000);
  });

  it('never hands the same number out twice, and counts up', async () => {
    const a = await newClient('a');
    const b = await newClient('b');
    expect(b.portalId).toBeGreaterThan(a.portalId);
  });

  it('keeps counting above 1,000,000 after an import below it', async () => {
    // The import range and the platform range never meet, whatever order the
    // import and new sign-ups arrive in.
    await importClient(26184);
    await importClient(199_999);
    const after = await newClient('after-import');
    expect(after.portalId).toBeGreaterThanOrEqual(1_000_000);
  });

  it('reads back through the store with the number on it', async () => {
    const created = await newClient('reread');
    const reread = await store.findById(created.id);
    expect(reread?.portalId).toBe(created.portalId);
  });
});

describe('the database refuses a number that would confuse two people', () => {
  it('accepts an old-platform number, as an importer writes it', async () => {
    expect(await pgCode(() => importClient(424242))).toBeUndefined();
  });

  it('refuses a DUPLICATE — two clients never share a Portal ID', async () => {
    await importClient(77);
    expect(await pgCode(() => importClient(77))).toBe('23505');
  });

  it('refuses zero and negatives', async () => {
    expect(await pgCode(() => importClient(0))).toBe('23514');
    expect(await pgCode(() => importClient(-5))).toBe('23514');
  });

  it('refuses NULL — every client has one', async () => {
    expect(await pgCode(() => importClient(null))).toBe('23502');
  });
});

describe('0133 numbers existing clients and is safe to run again', () => {
  const migration = readFileSync('src/database/migrations/0133_client_portal_id.sql', 'utf8');

  it('re-running it changes nothing and raises nothing', async () => {
    const before = await ctx.db.execute<{ id: string; portal_id: number }>(sql`
      SELECT id, portal_id FROM users ORDER BY id
    `);
    await ctx.db.execute(sql.raw(migration));
    const after = await ctx.db.execute<{ id: string; portal_id: number }>(sql`
      SELECT id, portal_id FROM users ORDER BY id
    `);
    expect(after.rows).toEqual(before.rows);
  });

  it('backfills clients who have none in sign-up order, above every existing number', async () => {
    /*
     * The state 0133 met in production: rows with no Portal ID. Recreated by
     * lifting NOT NULL and clearing two numbers, then running the file.
     */
    const older = await newClient('backfill-older');
    const newer = await newClient('backfill-newer');
    await ctx.db.execute(sql`
      UPDATE users SET created_at = now() - interval '2 days' WHERE id = ${older.id}
    `);
    await ctx.db.execute(sql`ALTER TABLE users ALTER COLUMN portal_id DROP NOT NULL`);
    await ctx.db.execute(sql`
      UPDATE users SET portal_id = NULL WHERE id IN (${older.id}, ${newer.id})
    `);
    const { rows: maxRows } = await ctx.db.execute<{ m: number }>(sql`
      SELECT max(portal_id) AS m FROM users
    `);
    const highest = Number(maxRows[0].m);

    await ctx.db.execute(sql.raw(migration));

    const refreshedOlder = await store.findById(older.id);
    const refreshedNewer = await store.findById(newer.id);
    // Above every number already held, the older sign-up first.
    expect(refreshedOlder!.portalId).toBe(highest + 1);
    expect(refreshedNewer!.portalId).toBe(highest + 2);

    // NOT NULL is back, and the sequence continues AFTER the backfill rather
    // than handing one of those numbers out again.
    expect(await pgCode(() => importClient(null))).toBe('23502');
    const next = await newClient('after-backfill');
    expect(next.portalId).toBeGreaterThan(highest + 2);
  });
});

describe('a search term is a Portal ID only when it is exactly one', () => {
  it.each([
    ['1000245', 1_000_245],
    ['26184', 26_184],
    ['1', 1],
    ['#1000245', 1_000_245],
    ['  1000245  ', 1_000_245],
    [' #26184 ', 26_184],
    ['2147483647', 2_147_483_647],
  ])('%j is Portal ID %d', (term, expected) => {
    expect(parsePortalId(term)).toBe(expected);
  });

  it.each([
    ['', 'empty'],
    ['   ', 'blank'],
    ['#', 'a bare #'],
    ['0', 'zero — no client holds it'],
    ['0123', 'a leading zero — an MT5 login keeps its zeros, a Portal ID has none'],
    ['-5', 'a sign'],
    ['1e5', 'an exponent'],
    ['12.5', 'a decimal point'],
    ['1 000 245', 'grouped digits'],
    ['2147483648', 'past the int4 column — comparing it would make Postgres raise'],
    ['99999999999', 'eleven digits'],
    ['１２３', 'full-width digits'],
    ['john', 'a name'],
    ['12ab', 'digits and letters'],
  ])('%j is not (%s)', (term) => {
    expect(parsePortalId(term)).toBeUndefined();
  });

  it('undefined is not', () => {
    expect(parsePortalId(undefined)).toBeUndefined();
  });
});

describe('every client search box reads digits as a Portal ID', () => {
  const dialect = new PgDialect();

  it('sends a Portal ID as an exact comparison, bound as a parameter', () => {
    const query = dialect.sqlToQuery(clientIdentitySearch('#1000245'));
    expect(query.sql).toBe('"users"."portal_id" = $1');
    expect(query.params).toEqual([1_000_245]);
  });

  it('sends anything else to the name/email search, escaped', () => {
    const query = dialect.sqlToQuery(clientIdentitySearch(' 50%_off '));
    expect(query.sql).toContain('ILIKE $1');
    expect(query.params).toEqual(['%50\\%\\_off%']);
  });

  it('finds exactly the client, and nobody whose email merely contains the digits', async () => {
    const target = await newClient('exact');
    // An email CONTAINING the target's number — the text search would match it.
    await ctx.db.execute(sql`
      INSERT INTO users (email, password_hash, first_name, last_name)
      VALUES (${`lookalike-${target.portalId}@oxshare-e2e.test`}, 'x', 'Look', 'Alike')
    `);
    const { rows } = await ctx.db.execute<{ id: string }>(sql`
      SELECT id FROM users WHERE ${clientIdentitySearch(String(target.portalId))}
    `);
    expect(rows.map((r) => r.id)).toEqual([target.id]);
  });

  it('finds an imported client by their old number', async () => {
    await importClient(31337);
    const { rows } = await ctx.db.execute<{ portal_id: number }>(sql`
      SELECT ${users.portalId} AS portal_id FROM users WHERE ${clientIdentitySearch('31337')}
    `);
    expect(rows.map((r) => Number(r.portal_id))).toEqual([31337]);
  });
});
