import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { AuditLogStore } from '../src/store/audit-log.store';
import { scopeOf, UNRESTRICTED } from '../src/common/security/client-scope';
import { startMoneyTestDb, stopMoneyTestDb, type MoneyTestContext } from './money-setup';

/**
 * The audit log can be INVESTIGATED, not only browsed.
 *
 * ## What was missing, and how it hid
 *
 * `/audit-log` offered two filters — `action` and `subjectType` — and both are
 * CATEGORIES. Neither answers either question an incident actually begins from:
 *
 *   "what did this administrator do"     -> the actor
 *   "what has been done to this client"  -> the subject
 *
 * So the way to answer them was to page an append-only table that grows forever
 * and read it, on the one record whose entire value is completeness. And the
 * gap was invisible from the store, because `findAll` had ACCEPTED `actorId`
 * since it was written and no route ever passed it: the filter existed, worked,
 * and was unreachable from the product. A parameter missing from a controller
 * reads exactly like a feature nobody built.
 *
 * ## The case that is a security property, not a convenience
 *
 * `q` searches `actor_email` and NOTHING else — in particular not `details`.
 * The details blob holds before/after values including client PII, and the
 * client-scope predicate below exists so a narrow-scoped reader cannot read
 * rows about clients outside their territory. A free-text match reaching inside
 * `details` would hand that back as a ROW COUNT: type an address, get one row,
 * and you have learned the client exists. The last two cases here are that
 * property, stated as tests rather than as a comment.
 */

let ctx: MoneyTestContext;
let store: AuditLogStore;
let aliceId: string;
let bobId: string;
let inScopeClientId: string;
let outScopeClientId: string;
let tagId: string;

async function makeClient(email: string): Promise<string> {
  const { rows } = await ctx.db.execute<{ id: string }>(sql`
    INSERT INTO users (email, password_hash, first_name, last_name)
    VALUES (${email}, 'x', 'Audit', 'Subject')
    RETURNING id
  `);
  return rows[0].id;
}

async function entry(
  actorId: string,
  actorEmail: string,
  action: string,
  subjectType: string,
  subjectId: string,
  details?: Record<string, unknown>,
) {
  await store.record({
    actorId,
    actorEmail,
    actorKind: 'admin',
    action,
    subjectType,
    subjectId,
    details,
    ipAddress: '127.0.0.1',
  });
}

beforeAll(async () => {
  ctx = await startMoneyTestDb();
  store = new AuditLogStore(ctx.db);

  const { rows: tagRows } = await ctx.db.execute<{ id: string }>(sql`
    INSERT INTO client_tags (slug, label) VALUES ('audit-desk', 'Audit Desk') RETURNING id
  `);
  tagId = tagRows[0].id;

  aliceId = crypto.randomUUID();
  bobId = crypto.randomUUID();
  inScopeClientId = await makeClient('audit-inscope@oxshare-e2e.test');
  outScopeClientId = await makeClient('audit-outscope@oxshare-e2e.test');

  await ctx.db.execute(sql`
    INSERT INTO client_tag_assignments (user_id, tag_id) VALUES (${inScopeClientId}, ${tagId})
  `);

  // TWO administrators acting on TWO clients, deliberately: every filter below
  // would also pass against a query that ignored its argument if the fixture
  // held one of each.
  await entry(aliceId, 'alice@oxshare.com', 'client.suspend', 'user', inScopeClientId);
  await entry(aliceId, 'alice@oxshare.com', 'client.reactivate', 'user', inScopeClientId);
  await entry(bobId, 'bob@oxshare.com', 'client.suspend', 'user', outScopeClientId);
  // A row whose DETAILS mention an address that appears in no `actor_email`.
  // The probe case below searches for it and must find nothing.
  await entry(aliceId, 'alice@oxshare.com', 'client.email_change', 'user', inScopeClientId, {
    from: 'secret-person@example.test',
    to: 'audit-inscope@oxshare-e2e.test',
  });
});

afterAll(async () => {
  await stopMoneyTestDb(ctx);
});

function find(filter: Parameters<AuditLogStore['findAll']>[0]) {
  return store.findAll({ limit: 50, ...filter });
}

describe('narrowing the audit log to one subject', () => {
  it('the fixture holds more than one actor and more than one subject', async () => {
    // The non-vacuity floor: without it a filter that matched everything would
    // satisfy every assertion in this file.
    const all = await find({ scope: UNRESTRICTED });
    expect(all.total).toBe(4);
    expect(new Set(all.items.map((r) => r.actorId)).size).toBe(2);
    expect(new Set(all.items.map((r) => r.subjectId)).size).toBe(2);
  });

  it('returns everything done to ONE client and nothing about the other', async () => {
    const found = await find({ scope: UNRESTRICTED, subjectId: inScopeClientId });
    expect(found.items.length).toBe(3);
    expect(found.items.every((r) => r.subjectId === inScopeClientId)).toBe(true);
    expect(found.total).toBe(3);
  });

  it('answers nothing, not everything, for a subject with no history', async () => {
    // The failure that reads as success: a predicate dropped by a later edit
    // turns "this client has no trail" into the whole log, and the reader
    // believes they are looking at one client's history.
    const found = await find({ scope: UNRESTRICTED, subjectId: crypto.randomUUID() });
    expect(found.items.length).toBe(0);
    expect(found.total).toBe(0);
  });
});

describe('narrowing the audit log to one administrator', () => {
  it('returns what ONE administrator did, by id', async () => {
    const found = await find({ scope: UNRESTRICTED, actorId: aliceId });
    expect(found.items.length).toBe(3);
    expect(found.items.every((r) => r.actorId === aliceId)).toBe(true);
    expect(found.total).toBe(3);
  });

  it('finds an administrator by PART of the email the row displays', async () => {
    // The screen shows `actorEmail`, so that is what an investigator types —
    // and they type the part they remember, which is why the index is trigram.
    const found = await find({ scope: UNRESTRICTED, q: 'bob@' });
    expect(found.items.length).toBe(1);
    expect(found.items[0].actorEmail).toBe('bob@oxshare.com');
  });

  it('is case-insensitive, because an operator types what they read', async () => {
    const found = await find({ scope: UNRESTRICTED, q: 'ALICE' });
    expect(found.items.length).toBe(3);
  });

  it('composes with the action filter rather than replacing it', async () => {
    // "What did Alice suspend" is one question, and two filters that overwrote
    // each other would answer a different one without saying so.
    const found = await find({ scope: UNRESTRICTED, q: 'alice', action: 'client.suspend' });
    expect(found.items.length).toBe(1);
    expect(found.items[0].action).toBe('client.suspend');
    expect(found.items[0].actorEmail).toBe('alice@oxshare.com');
  });

  it('counts the FILTERED set, so the pager does not promise rows the list has not got', async () => {
    const found = await find({ scope: UNRESTRICTED, q: 'bob' });
    expect(found.total).toBe(1);
  });
});

describe('the search cannot be turned into a probe for a client', () => {
  it('does NOT match inside `details`, where client PII lives', async () => {
    // `secret-person@example.test` is in one row's details and in no actor
    // email. If this ever returns a row, a reader can confirm an address exists
    // somewhere in the system by typing it into a search box — and `details`
    // carries addresses for clients they may not be allowed to see at all.
    const found = await find({ scope: UNRESTRICTED, q: 'secret-person@example.test' });
    expect(found.items.length).toBe(0);
    expect(found.total).toBe(0);
  });

  it('does not match the SUBJECT client’s email either', async () => {
    // Same property from the other side: the subject is stored as an id, and
    // the search reads the actor. A filter that resolved subject emails would
    // be the same existence probe with an extra join.
    const found = await find({ scope: UNRESTRICTED, q: 'audit-inscope@oxshare-e2e.test' });
    expect(found.items.length).toBe(0);
  });

  it('applies the filters INSIDE the reader’s territory, never instead of it', async () => {
    // D-54: client-subject rows follow the reader's client scope. A filter that
    // replaced the scope predicate rather than narrowing it would be a scope
    // escape wearing a search box — so the scoped desk must see Alice's rows
    // about their own client and NOT Bob's row about the client they may not
    // read, even when searching for Bob by name.
    const desk = scopeOf([tagId], false, false);

    const mine = await find({ scope: desk, q: 'alice' });
    expect(mine.items.length).toBe(3);
    expect(mine.items.every((r) => r.subjectId === inScopeClientId)).toBe(true);

    const theirs = await find({ scope: desk, q: 'bob' });
    expect(theirs.items.length).toBe(0);
    expect(theirs.total).toBe(0);

    // And asking for the out-of-scope client BY ID answers nothing, rather than
    // confirming the id names somebody.
    const byId = await find({ scope: desk, subjectId: outScopeClientId });
    expect(byId.items.length).toBe(0);
    expect(byId.total).toBe(0);
  });
});

describe('a client is found — and named — by Portal ID', () => {
  /*
   * The console identifies a client by Portal ID alone (0133), so the audit
   * search takes one and every row names clients by one: as the subject, as
   * the actor, and inside `details`. The uuid is what the row is keyed on and
   * never what a reader is shown.
   */
  let inScopePortalId: number;
  let outScopePortalId: number;
  const walletId = crypto.randomUUID();

  beforeAll(async () => {
    const { rows } = await ctx.db.execute<{ id: string; portal_id: number }>(sql`
      SELECT id, portal_id FROM users WHERE id IN (${inScopeClientId}, ${outScopeClientId})
    `);
    const portalIdOf = new Map(rows.map((r) => [r.id, Number(r.portal_id)]));
    inScopePortalId = portalIdOf.get(inScopeClientId)!;
    outScopePortalId = portalIdOf.get(outScopeClientId)!;

    // A money row: the subject is the transaction, the client only in details.
    await entry(aliceId, 'alice@oxshare.com', 'withdrawal.approve', 'transaction', walletId, {
      userId: inScopeClientId,
      walletId,
    });
    // A row the CLIENT performed.
    await store.record({
      actorId: inScopeClientId,
      actorEmail: 'audit-inscope@oxshare-e2e.test',
      actorKind: 'client',
      action: 'client.self_update',
      subjectType: 'session',
      subjectId: crypto.randomUUID(),
      ipAddress: '127.0.0.1',
    });
  });

  it('finds every row about the client — by subject AND inside details — and every row they did', async () => {
    const found = await find({ scope: UNRESTRICTED, q: String(inScopePortalId) });
    expect(found.items.map((r) => r.action).sort()).toEqual([
      'client.email_change',
      'client.reactivate',
      'client.self_update',
      'client.suspend',
      'withdrawal.approve',
    ]);
    expect(found.total).toBe(5);
  });

  it('names the client by Portal ID everywhere on the row, and never by uuid', async () => {
    const found = await find({ scope: UNRESTRICTED, q: String(inScopePortalId) });
    expect(
      JSON.stringify(found.items.map(({ actorId, subjectId, ...shown }) => shown)),
    ).not.toContain(inScopeClientId);

    const suspend = found.items.find((r) => r.action === 'client.suspend')!;
    expect(suspend.subjectPortalId).toBe(inScopePortalId);
    expect(suspend.clientPortalId).toBe(inScopePortalId);

    const performed = found.items.find((r) => r.action === 'client.self_update')!;
    expect(performed.actorPortalId).toBe(inScopePortalId);

    const money = found.items.find((r) => r.action === 'withdrawal.approve')!;
    expect(money.subjectPortalId).toBeNull();
    expect(money.clientPortalId).toBe(inScopePortalId);
    // The client's uuid became their Portal ID; the wallet's id is not a
    // client's and stays exactly as recorded.
    expect(money.details).toEqual({ userId: inScopePortalId, walletId });
  });

  it('shows a denied route’s path by Portal ID, and leaves a provider reference as issued', async () => {
    await entry(
      aliceId,
      'alice@oxshare.com',
      'route.denied',
      'route',
      `PATCH /v1/admin/clients/${inScopeClientId}/tags/${tagId}`,
      {
        reason: 'permission',
      },
    );
    await entry(
      aliceId,
      'alice@oxshare.com',
      'deposit.approve',
      'transaction',
      crypto.randomUUID(),
      {
        userId: inScopeClientId,
        providerRef: `psp-ref-${inScopeClientId}`,
      },
    );

    const routes = await find({ scope: UNRESTRICTED, action: 'route.denied' });
    // Our own path: the client's uuid becomes their Portal ID — a valid request
    // in its own right — and the TAG's id, not a client's, is untouched.
    expect(routes.items[0].subjectId).toBe(
      `PATCH /v1/admin/clients/${inScopePortalId}/tags/${tagId}`,
    );

    const deposits = await find({ scope: UNRESTRICTED, action: 'deposit.approve' });
    // Somebody else's identifier must read exactly as they issued it.
    expect(deposits.items[0].details).toEqual({
      userId: inScopePortalId,
      providerRef: `psp-ref-${inScopeClientId}`,
    });
  });

  it('gives an administrator actor no Portal ID — they have none', async () => {
    const found = await find({ scope: UNRESTRICTED, actorId: aliceId });
    expect(found.items.length).toBeGreaterThan(0);
    expect(found.items.every((r) => r.actorPortalId === null)).toBe(true);
  });

  it('finds nothing for a Portal ID outside the reader’s territory — the same as an unused one', async () => {
    const desk = scopeOf([tagId], false, false);
    const outside = await find({ scope: desk, q: String(outScopePortalId) });
    const unused = await find({ scope: desk, q: '999999999' });
    expect(outside.total).toBe(0);
    expect(unused.total).toBe(0);
    expect(outside.items).toEqual(unused.items);

    // …while their own client's number still finds their own client.
    const inside = await find({ scope: desk, q: String(inScopePortalId) });
    expect(inside.total).toBeGreaterThan(0);
  });
});
