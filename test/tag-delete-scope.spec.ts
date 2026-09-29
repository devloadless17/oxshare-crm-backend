import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { ALL_PERMISSIONS } from './support/all-permissions';
import { actingAs, startHttpTestApp, stopHttpTestApp, type HttpTestContext } from './http-setup';
import { PasswordService } from '../src/common/security/password.service';
import {
  adminClientTagScopes,
  admins,
  clientTagAssignments,
  clientTags,
  roles,
  users,
} from '../src/database/schema';

/**
 * A SCOPED ADMIN DELETES A TAG ONLY IF EVERY CLIENT CARRYING IT IS THEIRS.
 *
 * Deleting a tag removes it from every client that carries it. Before this,
 * a scoped admin holding `tags.delete` could:
 *   - change the records of clients outside their territory (they lose a tag
 *     the actor may not even see them carry), and
 *   - WIDEN THEIR OWN VIEW by it: a client whose only tag was deleted falls
 *     into the "new clients" pool, which an admin holding that grant sees.
 *
 * The refusal names HOW MANY clients are outside, never who — the owner's
 * "a count, no identity" rule (28 Sep 2026).
 */

const PASSWORD = 'admin-password-123';
const MASTER = { email: 'tagdel-master@oxshare.com', password: PASSWORD };
/** Territory: desk A, WITH the new-clients grant — the widening case. */
const SCOPED = { email: 'tagdel-scoped@oxshare.com', password: PASSWORD };

const TAGS = '/v1/admin/tags';

let ctx: HttpTestContext;
let deskA: string;
let deskB: string;
/** Carried by one client in desk A and one client in desk B only. */
let sharedTag: string;
/** Carried only by desk A's client. */
let ownTag: string;
let outsideClient: number;

async function tagExists(id: string): Promise<boolean> {
  const rows = await ctx.db.db.select().from(clientTags).where(eq(clientTags.id, id));
  return rows.length > 0;
}

beforeAll(async () => {
  ctx = await startHttpTestApp();
  const db = ctx.db.db;
  const hash = await new PasswordService().hash(PASSWORD);

  const tagRows = await db
    .insert(clientTags)
    .values([
      { slug: 'tagdel-desk-a', label: 'TagDel Desk A' },
      { slug: 'tagdel-desk-b', label: 'TagDel Desk B' },
      { slug: 'tagdel-shared', label: 'TagDel Shared' },
      { slug: 'tagdel-own', label: 'TagDel Own' },
    ])
    .returning();
  [deskA, deskB, sharedTag, ownTag] = tagRows.map((t) => t.id);

  const [masterRole] = await db
    .insert(roles)
    .values({ name: 'TagDel Master', permissions: ALL_PERMISSIONS })
    .returning();
  await db.insert(admins).values({
    email: MASTER.email,
    passwordHash: hash,
    name: 'TagDel Master',
    role: 'sub_admin',
    roleId: masterRole.id,
    permissions: [],
    status: 'active',
  });

  const [deskRole] = await db
    .insert(roles)
    .values({ name: 'TagDel Desk', permissions: ['clients.view', 'tags.view', 'tags.delete'] })
    .returning();
  const [scoped] = await db
    .insert(admins)
    .values({
      email: SCOPED.email,
      passwordHash: hash,
      name: 'TagDel Scoped',
      role: 'sub_admin',
      roleId: deskRole.id,
      permissions: [],
      seesUntriaged: true,
      status: 'active',
    })
    .returning();
  await db
    .insert(adminClientTagScopes)
    .values({ adminId: scoped.id, tagId: deskA, createdBy: scoped.id });

  const client = async (label: string, tags: string[]) => {
    const [row] = await db
      .insert(users)
      .values({
        email: `tagdel-${label}@oxshare-e2e.test`,
        passwordHash: 'x',
        firstName: 'TagDel',
        lastName: label,
      })
      .returning();
    await db.insert(clientTagAssignments).values(tags.map((tagId) => ({ userId: row.id, tagId })));
    return row.id;
  };
  await client('inside', [deskA, sharedTag, ownTag]);
  // Outside desk A, and its ONLY other tag is `sharedTag`'s partner desk B.
  outsideClient = await client('outside', [deskB, sharedTag]);
});

afterAll(async () => {
  await stopHttpTestApp(ctx);
});

describe('a scoped admin deleting a tag', () => {
  it('is refused when a client outside their territory carries it — with a count, no identity', async () => {
    const session = await actingAs(ctx, 'admin', SCOPED);
    const res = await session.del(`${TAGS}/${sharedTag}`);

    expect(res.status).toBe(409);
    const message = (res.body as { message: string }).message;
    expect(message).toMatch(/1 client outside your territory/);
    expect(message, 'the refusal named the client it withheld').not.toMatch(/tagdel-outside/i);

    // Refused means NOT written: the tag, and the outside client's copy of it, stay.
    expect(await tagExists(sharedTag)).toBe(true);
    const outsideTags = await ctx.db.db
      .select({ tagId: clientTagAssignments.tagId })
      .from(clientTagAssignments)
      .where(eq(clientTagAssignments.userId, outsideClient));
    expect(outsideTags.map((t) => t.tagId)).toContain(sharedTag);
  });

  it('is allowed when every client carrying it is theirs', async () => {
    const session = await actingAs(ctx, 'admin', SCOPED);
    await session.del(`${TAGS}/${ownTag}`).expect(200);
    expect(await tagExists(ownTag)).toBe(false);
  });

  it('an unrestricted admin deletes the shared tag — the refusal was about the reader', async () => {
    const session = await actingAs(ctx, 'admin', MASTER);
    await session.del(`${TAGS}/${sharedTag}`).expect(200);
    expect(await tagExists(sharedTag)).toBe(false);
  });
});
