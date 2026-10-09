import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, inArray, sql } from 'drizzle-orm';
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
 * The twin is fed what `ClientTagsStore.tagIdsForClient` returns, so this
 * matrix pins the store as well: every subset of two tags, against every scope
 * shape. (Country tags, 0193–0212, were removed in 0213: a tag is a book.)
 */

let ctx: MoneyTestContext;
let store: ClientTagsStore;
let t1: string;
let t2: string;
const clients: number[] = [];

const SCOPES = ['unrestricted', 'tag 1', 'tag 2', 'tags 1 and 2', 'no tags'] as const;
type ScopeName = (typeof SCOPES)[number];

function scopeNamed(name: ScopeName): ClientScope {
  switch (name) {
    case 'unrestricted':
      return UNRESTRICTED;
    case 'tag 1':
      return { unrestricted: false, tagIds: [t1] };
    case 'tags 1 and 2':
      return { unrestricted: false, tagIds: [t1, t2] };
    case 'tag 2':
      return { unrestricted: false, tagIds: [t2] };
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

beforeAll(async () => {
  ctx = await startMoneyTestDb();
  store = new ClientTagsStore(ctx.db);
  [t1, t2] = await Promise.all(
    [1, 2].map(async (n) => {
      const [tag] = await ctx.db
        .insert(clientTags)
        .values({ slug: `twin-tag-${n}`, label: `Twin Tag ${n}` })
        .returning();
      return tag.id;
    }),
  );

  for (let subset = 0; subset < 4; subset++) {
    const tags = [t1, t2].filter((_, i) => (subset & (1 << i)) !== 0);
    const [client] = await ctx.db
      .insert(users)
      .values({
        email: `twin-${subset}@oxshare-e2e.test`,
        passwordHash: 'x',
        firstName: 'Twin',
        lastName: `Subset`,
      })
      .returning();
    if (tags.length > 0) {
      await ctx.db
        .insert(clientTagAssignments)
        .values(tags.map((tagId) => ({ userId: client.id, tagId })));
    }
    clients.push(client.id);
  }
});

afterAll(async () => {
  await stopMoneyTestDb(ctx);
});

describe('seesClientWithTags agrees with clientScopePredicate on every tag set', () => {
  for (const name of SCOPES) {
    it(`scope "${name}"`, async () => {
      const scope = scopeNamed(name);
      const bySql = await visibleBySql(scope);
      const disagreements: number[] = [];
      for (const id of clients) {
        const tags = await store.tagIdsForClient(id);
        if (bySql.has(id) !== seesClientWithTags(scope, tags)) disagreements.push(id);
      }
      expect(disagreements, `the twin disagrees with the SQL for scope "${name}"`).toEqual([]);
    });
  }

  it('is not vacuous — the matrix really separates the scopes', async () => {
    expect((await visibleBySql(scopeNamed('unrestricted'))).size).toBe(4);
    // The two subsets containing tag 1; likewise tag 2.
    expect((await visibleBySql(scopeNamed('tag 1'))).size).toBe(2);
    expect((await visibleBySql(scopeNamed('tag 2'))).size).toBe(2);
    // Everyone but the untagged client.
    expect((await visibleBySql(scopeNamed('tags 1 and 2'))).size).toBe(3);
    expect((await visibleBySql(scopeNamed('no tags'))).size).toBe(0);
  });
});

describe("the client's country is a checked detail, never a tag (0193, 0213)", () => {
  it('refuses a client without a country, or with one the platform does not know', async () => {
    await expect(
      ctx.db.execute(sql`UPDATE users SET country = NULL WHERE id = ${clients[0]}`),
    ).rejects.toThrow();
    await expect(
      ctx.db.execute(sql`UPDATE users SET country = 'Atlantis' WHERE id = ${clients[0]}`),
    ).rejects.toThrow();
  });

  it('defaults a raw insert to Unknown, and gives it no tag', async () => {
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
    expect(await store.tagIdsForClient(row.id)).toEqual([]);
  });
});
