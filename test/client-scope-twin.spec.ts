import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, inArray } from 'drizzle-orm';
import {
  clientScopePredicate,
  seesClientWithTags,
  UNRESTRICTED,
  type ClientScope,
} from '../src/common/security/client-scope';
import { clientTagAssignments, clientTags, users } from '../src/database/schema';
import { startMoneyTestDb, stopMoneyTestDb, type MoneyTestContext } from './money-setup';

/**
 * ONE DEFINITION OF VISIBILITY, TWO SPELLINGS — AND THIS HOLDS THEM TOGETHER.
 *
 * `clientScopePredicate` is the SQL every list and by-id read applies.
 * `seesClientWithTags` is its in-memory twin, used where the tag set does not
 * exist yet: a tag change is judged on the set it WILL leave ("does this take
 * the client out of my view?") before anything is written.
 *
 * Two definitions drift the moment one is edited alone, and a drift here is
 * silent in the worst direction: the console would let an admin hand a client
 * away without the confirmation, or ask for one when nothing leaves. So the SQL
 * is treated as the truth and the twin must agree on every cell of a complete
 * matrix — every subset of three tags (one client each) against every scope
 * shape the predicate distinguishes.
 */

let ctx: MoneyTestContext;
const tagIds: string[] = [];
/** Each fixture client, with the tag ids it carries. */
const carried = new Map<number, string[]>();

const SCOPES = [
  'unrestricted',
  'one tag',
  'one tag + new clients',
  'two tags',
  'two tags + new clients',
  'all three tags',
  'new clients only',
  'no tags, no new clients',
] as const;
type ScopeName = (typeof SCOPES)[number];

/** Built on demand: the tag ids only exist once `beforeAll` has run. */
function scopeNamed(name: ScopeName): ClientScope {
  const [t1, t2, t3] = tagIds;
  switch (name) {
    case 'unrestricted':
      return UNRESTRICTED;
    case 'one tag':
      return { unrestricted: false, tagIds: [t1] };
    case 'one tag + new clients':
      return { unrestricted: false, tagIds: [t1], includesUntriaged: true };
    case 'two tags':
      return { unrestricted: false, tagIds: [t1, t2] };
    case 'two tags + new clients':
      return { unrestricted: false, tagIds: [t1, t2], includesUntriaged: true };
    case 'all three tags':
      return { unrestricted: false, tagIds: [t1, t2, t3] };
    case 'new clients only':
      return { unrestricted: false, tagIds: [], includesUntriaged: true };
    case 'no tags, no new clients':
      // The fail-closed shape: the predicate answers `false` for it.
      return { unrestricted: false, tagIds: [] };
  }
}

async function visibleBySql(scope: ClientScope): Promise<Set<number>> {
  const rows = await ctx.db
    .select({ id: users.id })
    .from(users)
    .where(and(inArray(users.id, [...carried.keys()]), clientScopePredicate(scope, users.id)));
  return new Set(rows.map((row) => row.id));
}

beforeAll(async () => {
  ctx = await startMoneyTestDb();

  for (const n of [1, 2, 3]) {
    const [tag] = await ctx.db
      .insert(clientTags)
      .values({ slug: `twin-tag-${n}`, label: `Twin Tag ${n}` })
      .returning();
    tagIds.push(tag.id);
  }

  // Every subset of the three tags, the empty set included.
  for (let subset = 0; subset < 8; subset++) {
    const tags = tagIds.filter((_, i) => (subset & (1 << i)) !== 0);
    const [client] = await ctx.db
      .insert(users)
      .values({
        email: `twin-${subset}@oxshare-e2e.test`,
        passwordHash: 'x',
        firstName: 'Twin',
        lastName: `Subset${subset}`,
      })
      .returning();
    if (tags.length > 0) {
      await ctx.db
        .insert(clientTagAssignments)
        .values(tags.map((tagId) => ({ userId: client.id, tagId })));
    }
    carried.set(client.id, tags);
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

      const disagreements = [...carried.entries()]
        .filter(([id, tags]) => bySql.has(id) !== seesClientWithTags(scope, tags))
        .map(([id, tags]) => ({
          tags: tags.map((tagId) => `tag ${tagIds.indexOf(tagId) + 1}`),
          sql: bySql.has(id),
          twin: seesClientWithTags(scope, tags),
        }));

      expect(disagreements, `the twin disagrees with the SQL for scope "${name}"`).toEqual([]);
    });
  }

  it('is not vacuous — the matrix really separates the scopes', async () => {
    /*
     * Without this, a predicate and a twin that both answered "everyone" (or
     * "no one") would agree on every cell above. Pin the counts the SQL itself
     * produces for three shapes whose answers are known by hand.
     */
    expect((await visibleBySql(scopeNamed('unrestricted'))).size).toBe(8);
    // Subsets containing tag 1: 4 of 8.
    expect((await visibleBySql(scopeNamed('one tag'))).size).toBe(4);
    // Plus the one client with no tags at all.
    expect((await visibleBySql(scopeNamed('one tag + new clients'))).size).toBe(5);
    expect((await visibleBySql(scopeNamed('new clients only'))).size).toBe(1);
    expect((await visibleBySql(scopeNamed('no tags, no new clients'))).size).toBe(0);
  });
});
