import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq, inArray, sql } from 'drizzle-orm';
import {
  clientScopePredicate,
  seesClientWithTags,
  UNRESTRICTED,
  type ClientScope,
} from '../src/common/security/client-scope';
import { clientTagAssignments, clientTags, users } from '../src/database/schema';
import { ClientTagsStore } from '../src/store/client-tags.store';
import { startMoneyTestDb, stopMoneyTestDb, type MoneyTestContext } from './money-setup';

/**
 * ONE DEFINITION OF VISIBILITY, TWO SPELLINGS — AND THIS HOLDS THEM TOGETHER.
 *
 * `clientScopePredicate` is the SQL every list and by-id read applies.
 * `seesClientWithTags` is its in-memory twin, used where the tag set does not
 * exist yet: a tag change is judged on the set it WILL leave ("does this take
 * the client out of my view?") before anything is written.
 *
 * Since 0193 a client's tags are MEMBERSHIPS: the tags somebody assigned plus
 * the COUNTRY tag derived from `users.country`. The twin is fed what
 * `ClientTagsStore.tagIdsForClient` returns, so this matrix pins the store and
 * the view as well: every subset of two chosen tags, in each of two countries,
 * against every scope shape — a chosen territory, a country desk, and both.
 */

let ctx: MoneyTestContext;
let store: ClientTagsStore;
let t1: string;
let t2: string;
let lebanon: string;
let egypt: string;
const clients: number[] = [];

const SCOPES = [
  'unrestricted',
  'tag 1',
  'tags 1 and 2',
  'Lebanon desk',
  'tag 1 + Egypt desk',
  'no tags',
] as const;
type ScopeName = (typeof SCOPES)[number];

function scopeNamed(name: ScopeName): ClientScope {
  switch (name) {
    case 'unrestricted':
      return UNRESTRICTED;
    case 'tag 1':
      return { unrestricted: false, tagIds: [t1] };
    case 'tags 1 and 2':
      return { unrestricted: false, tagIds: [t1, t2] };
    case 'Lebanon desk':
      return { unrestricted: false, tagIds: [lebanon] };
    case 'tag 1 + Egypt desk':
      return { unrestricted: false, tagIds: [t1, egypt] };
    case 'no tags':
      // The fail-closed shape: the predicate answers `false` for it.
      return { unrestricted: false, tagIds: [] };
  }
}

async function visibleBySql(scope: ClientScope): Promise<Set<number>> {
  const rows = await ctx.db
    .select({ id: users.id })
    .from(users)
    .where(and(inArray(users.id, clients), clientScopePredicate(scope, users.id)));
  return new Set(rows.map((row) => row.id));
}

async function countryTag(name: string): Promise<string> {
  const [row] = await ctx.db
    .select({ id: clientTags.id })
    .from(clientTags)
    .where(sql`${clientTags.label} = ${name} AND ${clientTags.countryCode} IS NOT NULL`);
  return row.id;
}

beforeAll(async () => {
  ctx = await startMoneyTestDb();
  store = new ClientTagsStore(ctx.db);
  lebanon = await countryTag('Lebanon');
  egypt = await countryTag('Egypt');
  [t1, t2] = await Promise.all(
    [1, 2].map(async (n) => {
      const [tag] = await ctx.db
        .insert(clientTags)
        .values({ slug: `twin-tag-${n}`, label: `Twin Tag ${n}` })
        .returning();
      return tag.id;
    }),
  );

  for (const country of ['Lebanon', 'Egypt']) {
    for (let subset = 0; subset < 4; subset++) {
      const tags = [t1, t2].filter((_, i) => (subset & (1 << i)) !== 0);
      const [client] = await ctx.db
        .insert(users)
        .values({
          email: `twin-${country}-${subset}@oxshare-e2e.test`,
          passwordHash: 'x',
          firstName: 'Twin',
          lastName: `Subset`,
          country,
        })
        .returning();
      if (tags.length > 0) {
        await ctx.db
          .insert(clientTagAssignments)
          .values(tags.map((tagId) => ({ userId: client.id, tagId })));
      }
      clients.push(client.id);
    }
  }
});

afterAll(async () => {
  await stopMoneyTestDb(ctx);
});

describe('seesClientWithTags agrees with clientScopePredicate on every membership set', () => {
  for (const name of SCOPES) {
    it(`scope "${name}"`, async () => {
      const scope = scopeNamed(name);
      const bySql = await visibleBySql(scope);
      const disagreements: number[] = [];
      for (const id of clients) {
        const memberships = await store.tagIdsForClient(id);
        if (bySql.has(id) !== seesClientWithTags(scope, memberships)) disagreements.push(id);
      }
      expect(disagreements, `the twin disagrees with the SQL for scope "${name}"`).toEqual([]);
    });
  }

  it('is not vacuous — the matrix really separates the scopes', async () => {
    expect((await visibleBySql(scopeNamed('unrestricted'))).size).toBe(8);
    // Subsets containing tag 1, in both countries: 2 × 2.
    expect((await visibleBySql(scopeNamed('tag 1'))).size).toBe(4);
    expect((await visibleBySql(scopeNamed('tags 1 and 2'))).size).toBe(6);
    // Every Lebanese client, whatever else they carry.
    expect((await visibleBySql(scopeNamed('Lebanon desk'))).size).toBe(4);
    // Every Egyptian client, plus the two Lebanese ones carrying tag 1.
    expect((await visibleBySql(scopeNamed('tag 1 + Egypt desk'))).size).toBe(6);
    expect((await visibleBySql(scopeNamed('no tags'))).size).toBe(0);
  });
});

describe('the country tag is derived, and Postgres keeps it that way (0193)', () => {
  it('follows the client when their country changes', async () => {
    const [moving] = clients;
    const desk = scopeNamed('Lebanon desk');
    expect((await visibleBySql(desk)).has(moving)).toBe(true);
    await ctx.db.update(users).set({ country: 'Egypt' }).where(eq(users.id, moving));
    expect((await visibleBySql(desk)).has(moving)).toBe(false);
    expect(await store.tagIdsForClient(moving)).toContain(egypt);
    await ctx.db.update(users).set({ country: 'Lebanon' }).where(eq(users.id, moving));
  });

  it('refuses a client without a country, or with one the platform does not know', async () => {
    await expect(
      ctx.db.execute(sql`UPDATE users SET country = NULL WHERE id = ${clients[0]}`),
    ).rejects.toThrow();
    await expect(
      ctx.db.execute(sql`UPDATE users SET country = 'Atlantis' WHERE id = ${clients[0]}`),
    ).rejects.toThrow();
  });

  it('defaults a raw insert to Unknown, which is itself a country tag', async () => {
    const [row] = await ctx.db
      .insert(users)
      .values({
        email: 'twin-nocountry@oxshare-e2e.test',
        passwordHash: 'x',
        firstName: 'N',
        lastName: 'C',
      })
      .returning();
    expect(row.country).toBe('Unknown');
    expect(await store.tagIdsForClient(row.id)).toEqual([await countryTag('Unknown')]);
  });

  it('refuses assigning, deleting or re-pointing a country tag', async () => {
    await expect(
      ctx.db.insert(clientTagAssignments).values({ userId: clients[0], tagId: egypt }),
    ).rejects.toThrow();
    await expect(ctx.db.delete(clientTags).where(eq(clientTags.id, egypt))).rejects.toThrow();
    await expect(
      ctx.db.update(clientTags).set({ countryCode: 'LB' }).where(eq(clientTags.id, egypt)),
    ).rejects.toThrow();
    // Its colour is the desk's.
    await ctx.db.update(clientTags).set({ color: 'blue' }).where(eq(clientTags.id, egypt));
  });
});
