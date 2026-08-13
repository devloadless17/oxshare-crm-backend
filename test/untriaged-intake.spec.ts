import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { clientScopePredicate, scopeOf, UNRESTRICTED } from '../src/common/security/client-scope';
import { clientTagAssignments, clientTags, users } from '../src/database/schema';
import { startMoneyTestDb, stopMoneyTestDb, type MoneyTestContext } from './money-setup';

/**
 * D-60, final form — "new client" is a DERIVED STATE, not a tag.
 *
 * "Untriaged" means exactly "carries no tag assignments", honoured by
 * `clientScopePredicate` as an ADDITIVE OR-branch for scoped admins holding
 * the `sees_untriaged` grant (TRUE BY DEFAULT since 0058 — restriction is the
 * explicit act). The grant never restricts: an admin with no territories is
 * unrestricted regardless of it, pure D-10 — the earlier "intake-only" reading
 * of that shape died when the default flipped, because a default must never be
 * the thing that restricts.
 *
 * The decisive property stays: every client is always either in a territory
 * or in intake — an invisible client cannot exist. Against real Postgres,
 * because the property IS the SQL the predicate emits.
 */

let ctx: MoneyTestContext;
let territoryTagId: string;
/** A second territory nobody is assigned to — the clean INTAKE LENS: a scoped
 *  admin holding it plus the grant sees exactly the untriaged pool. */
let emptyTagId: string;
let taggedClientId: string;
let untaggedClientId: string;

const intakeLens = () => scopeOf([emptyTagId], true);

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
  const [empty] = await ctx.db
    .insert(clientTags)
    .values({ slug: 'empty-desk', label: 'Empty Desk' })
    .returning();
  emptyTagId = empty.id;

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
  it('the grant is ADDITIVE — with no territories it changes nothing (pure D-10)', () => {
    // The default-true world's load-bearing rule: every unrestricted admin
    // carries the grant, so it must never be the thing that restricts.
    expect(scopeOf([], true)).toBe(UNRESTRICTED);
    expect(scopeOf([], false)).toBe(UNRESTRICTED);
    expect(clientScopePredicate(UNRESTRICTED, users.id)).toBeUndefined();
  });

  it('a scoped admin with the grant sees their territory PLUS the untriaged pool', async () => {
    const withGrant = await visibleTo(scopeOf([territoryTagId], true));
    expect(withGrant).toContain(taggedClientId);
    expect(withGrant).toContain(untaggedClientId);

    const withoutGrant = await visibleTo(scopeOf([territoryTagId], false));
    expect(withoutGrant).toContain(taggedClientId);
    expect(withoutGrant).not.toContain(untaggedClientId);
  });

  it('the intake lens sees exactly the untriaged: the grant never leaks other territories', async () => {
    const lens = await visibleTo(intakeLens());
    expect(lens).toContain(untaggedClientId);
    expect(lens).not.toContain(taggedClientId);
  });

  it('no orphan class: a client whose last tag is removed RETURNS to intake', async () => {
    /*
     * The decisive property, and the one the materialised-tag design could
     * not give: between territories a client is in intake — never invisible.
     * The union of territory admins and grant holders covers every client at
     * every moment.
     */
    await ctx.db
      .delete(clientTagAssignments)
      .where(eq(clientTagAssignments.userId, taggedClientId));

    expect(await visibleTo(intakeLens())).toContain(taggedClientId);
    expect(await visibleTo(scopeOf([territoryTagId], false))).not.toContain(taggedClientId);
  });

  it('assigning any tag ends the intake state by definition', async () => {
    await ctx.db
      .insert(clientTagAssignments)
      .values({ userId: untaggedClientId, tagId: territoryTagId });

    expect(await visibleTo(intakeLens())).not.toContain(untaggedClientId);
    expect(await visibleTo(scopeOf([territoryTagId], false))).toContain(untaggedClientId);
  });

  it('fails CLOSED if a restricted scope ever arrives empty-handed', async () => {
    const broken = { unrestricted: false as const, tagIds: [] };
    const predicate = clientScopePredicate(broken, users.id);
    expect(predicate).toBeDefined();
    const rows = await ctx.db.select({ id: users.id }).from(users).where(predicate);
    expect(rows).toEqual([]);
  });
});
