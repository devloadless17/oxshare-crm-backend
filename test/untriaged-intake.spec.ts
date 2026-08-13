import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { clientScopePredicate, scopeOf, UNRESTRICTED } from '../src/common/security/client-scope';
import { clientTagAssignments, clientTags, users } from '../src/database/schema';
import { startMoneyTestDb, stopMoneyTestDb, type MoneyTestContext } from './money-setup';

/**
 * D-60, final form — "new client" is a DERIVED STATE, not a tag.
 *
 * "Untriaged" means exactly "carries no tag assignments", honoured by
 * `clientScopePredicate` as an OR-branch for admins holding the
 * `sees_untriaged` grant. A materialised intake tag was tried and reverted
 * (migrations 0055–0057): stored derived state needed three guards to stay
 * true and still allowed an ORPHAN CLASS — remove a client's last territory
 * tag and nobody scoped could see them. Under the derived model that client
 * RETURNS to intake instead: every client is always either in a territory or
 * in intake, and an invisible client cannot exist.
 *
 * Against real Postgres, because the property IS the SQL the predicate emits.
 */

let ctx: MoneyTestContext;
let territoryTagId: string;
let taggedClientId: string;
let untaggedClientId: string;

async function visibleTo(scope: ReturnType<typeof scopeOf>): Promise<string[]> {
  const predicate = clientScopePredicate(scope, users.id);
  const rows = await ctx.db.select({ id: users.id }).from(users).where(predicate);
  return rows.map((r) => r.id);
}

beforeAll(async () => {
  ctx = await startMoneyTestDb();

  const [territory] = await ctx.db
    .insert(clientTags)
    .values({ slug: 'levant-desk', label: 'Levant Desk' })
    .returning();
  territoryTagId = territory.id;

  const [tagged] = await ctx.db
    .insert(users)
    .values({
      email: 'triaged@oxshare-e2e.test',
      passwordHash: 'x',
      firstName: 'Tri',
      lastName: 'Aged',
    })
    .returning();
  taggedClientId = tagged.id;
  await ctx.db.insert(clientTagAssignments).values({ userId: tagged.id, tagId: territory.id });

  const [fresh] = await ctx.db
    .insert(users)
    .values({
      email: 'fresh@oxshare-e2e.test',
      passwordHash: 'x',
      firstName: 'Fresh',
      lastName: 'Registrant',
    })
    .returning();
  untaggedClientId = fresh.id;
});

afterAll(async () => {
  await stopMoneyTestDb(ctx);
});

describe('the intake pool is a derived state (D-60)', () => {
  it('an intake-only admin sees exactly the untriaged clients', async () => {
    // The grant with NO territory tags is intake-only, not unrestricted —
    // the deliberate narrowing of D-10's empty-means-unrestricted rule.
    const scope = scopeOf([], true);
    expect(scope.unrestricted).toBe(false);

    const visible = await visibleTo(scope);
    expect(visible).toContain(untaggedClientId);
    expect(visible).not.toContain(taggedClientId);
  });

  it('a territory admin with the grant sees both pools; without it, only the territory', async () => {
    const withGrant = await visibleTo(scopeOf([territoryTagId], true));
    expect(withGrant).toContain(taggedClientId);
    expect(withGrant).toContain(untaggedClientId);

    const withoutGrant = await visibleTo(scopeOf([territoryTagId], false));
    expect(withoutGrant).toContain(taggedClientId);
    expect(withoutGrant).not.toContain(untaggedClientId);
  });

  it('no orphan class: a client whose last tag is removed RETURNS to intake', async () => {
    /*
     * The decisive property of the derived model, and the one the tag model
     * could not give: between territories, a client is in intake — never
     * invisible. The union of "any territory admin" and "any intake admin"
     * covers every client at every moment.
     */
    await ctx.db
      .delete(clientTagAssignments)
      .where(eq(clientTagAssignments.userId, taggedClientId));

    const intake = await visibleTo(scopeOf([], true));
    expect(intake).toContain(taggedClientId);

    const territory = await visibleTo(scopeOf([territoryTagId], false));
    expect(territory).not.toContain(taggedClientId);
  });

  it('assigning any tag ends the intake state by definition', async () => {
    await ctx.db
      .insert(clientTagAssignments)
      .values({ userId: untaggedClientId, tagId: territoryTagId });

    const intake = await visibleTo(scopeOf([], true));
    expect(intake).not.toContain(untaggedClientId);

    const territory = await visibleTo(scopeOf([territoryTagId], false));
    expect(territory).toContain(untaggedClientId);
  });

  it('neither tags nor the grant means unrestricted, exactly as before (D-10)', () => {
    expect(scopeOf([], false)).toBe(UNRESTRICTED);
    expect(clientScopePredicate(UNRESTRICTED, users.id)).toBeUndefined();
  });

  it('fails CLOSED if a restricted scope ever arrives empty-handed', async () => {
    const broken = { unrestricted: false as const, tagIds: [] };
    const predicate = clientScopePredicate(broken, users.id);
    expect(predicate).toBeDefined();
    const rows = await ctx.db.select({ id: users.id }).from(users).where(predicate);
    expect(rows).toEqual([]);
  });
});
