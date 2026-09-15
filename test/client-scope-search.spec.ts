import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { ALL_PERMISSIONS } from './support/all-permissions';
import {
  actingAs,
  startHttpTestApp,
  stopHttpTestApp,
  type HttpTestContext,
  type Session,
} from './http-setup';
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
 * A FILTER IS NOT A WAY AROUND THE TERRITORY.
 *
 * ## The question, and why it needs its own file
 *
 * A scoped admin sees the clients in their territory. `client-scope-enforcement
 * .spec.ts` proves that for the LISTS — but it proves it with an out-of-scope
 * client who owns nothing, and it says so: *"the out-of-scope client carries no
 * wallet or trading account in this fixture, so these assert the weaker half"*.
 * A boundary demonstrated against an empty other side is a boundary nobody has
 * pushed on.
 *
 * And every list has since gained a SEARCH, which is a new way to ask for a
 * specific row. Two of those searches are matches on an IDENTIFIER — a wallet
 * number, an MT5 login — which is the sharpest possible probe: the caller names
 * exactly one row and asks whether it exists. If the scope predicate is not on
 * that query, a scoped desk can walk the whole platform one number at a time,
 * and the reply is indistinguishable from the feature working.
 *
 * So this file gives the OUT-OF-SCOPE client everything — a wallet with a
 * number, a trading account with a login, ledger entries, an audit trail — and
 * then tries to reach each of them from the scoped session, by every filter the
 * API offers.
 *
 * ## Every case is paired with a MASTER control
 *
 * Because "the scoped admin saw nothing" has two causes: the boundary held, or
 * there was nothing there. Only the second is a bug in the test, and only the
 * master control tells them apart.
 */

const MASTER = { email: 'scope-search-master@oxshare.com', password: 'admin-password-123' };
const SCOPED = { email: 'scope-search-scoped@oxshare.com', password: 'admin-password-123' };

const MINE = { email: 'scope-search-mine@oxshare-e2e.test', first: 'Mine', last: 'Inside' };
/** Deliberately distinctive: every probe below searches for this person. */
const THEIRS = {
  email: 'scope-search-theirs@oxshare-e2e.test',
  first: 'Zephyrine',
  last: 'Outside',
};

/** Nobody has triaged this one yet — the D-60 intake pool. */
const UNTRIAGED = {
  email: 'scope-search-untriaged@oxshare-e2e.test',
  first: 'Quillon',
  last: 'Unsorted',
};

const THEIR_LOGIN = '80000042';
const MY_LOGIN = '80000001';

let ctx: HttpTestContext;
let scoped: Session;
let master: Session;
let mineId: string;
let theirsId: string;
let untriagedId: string;
let theirWalletNumber: string;

const items = (body: unknown) => (body as { items?: unknown[] }).items ?? [];
const rowsOf = (body: unknown) =>
  ((body as { items?: unknown[]; rows?: unknown[] }).items ??
    (body as { rows?: unknown[] }).rows ??
    []) as Record<string, unknown>[];

beforeAll(async () => {
  ctx = await startHttpTestApp();
  const db = ctx.db.db;
  const passwords = new PasswordService();

  const [masterRole] = await db
    .insert(roles)
    .values({ name: 'Scope Search Master', permissions: ALL_PERMISSIONS, isSystem: true })
    .returning();
  await db.insert(admins).values({
    email: MASTER.email,
    passwordHash: await passwords.hash(MASTER.password),
    name: 'Scope Search Master',
    role: 'master_admin',
    roleId: masterRole.id,
    permissions: ALL_PERMISSIONS,
    status: 'active',
  });

  /*
   * The scoped admin holds EVERY PERMISSION. That is the point: this file is
   * about the TERRITORY, not about permissions. An admin who could not read
   * wallets at all would answer 403 everywhere and prove nothing about scope.
   */
  const [scopedRole] = await db
    .insert(roles)
    .values({ name: 'Scope Search Scoped', permissions: ALL_PERMISSIONS, isSystem: false })
    .returning();
  const [scopedAdmin] = await db
    .insert(admins)
    .values({
      email: SCOPED.email,
      passwordHash: await passwords.hash(SCOPED.password),
      name: 'Scope Search Scoped',
      role: 'sub_admin',
      roleId: scopedRole.id,
      permissions: ALL_PERMISSIONS,
      status: 'active',
    })
    .returning();

  const [tag, otherTag] = await db
    .insert(clientTags)
    .values([
      { slug: 'scope-search-mine', label: 'Scope Search Mine' },
      { slug: 'scope-search-theirs', label: 'Scope Search Theirs' },
    ])
    .returning();

  const [mine, theirs, untriaged] = await db
    .insert(users)
    .values([
      { email: MINE.email, passwordHash: 'x', firstName: MINE.first, lastName: MINE.last },
      { email: THEIRS.email, passwordHash: 'x', firstName: THEIRS.first, lastName: THEIRS.last },
      {
        email: UNTRIAGED.email,
        passwordHash: 'x',
        firstName: UNTRIAGED.first,
        lastName: UNTRIAGED.last,
      },
    ])
    .returning();
  mineId = mine.id;
  theirsId = theirs.id;
  untriagedId = untriaged.id;

  /*
   * ⚠️ THE OUT-OF-SCOPE CLIENT CARRIES ANOTHER DESK'S TAG, and getting this
   * wrong is how a scope test quietly proves nothing.
   *
   * `admins.sees_untriaged` DEFAULTS TO TRUE (D-60, the intake pool): a scoped
   * reader also sees clients carrying NO tags at all, so that completing a
   * triage does not make a client invisible to the person triaging. An
   * "out-of-scope" client left untagged is therefore LEGITIMATELY VISIBLE, and
   * the first version of this file asserted against that and read as six scope
   * leaks. The client outside the territory has to be triaged INTO somewhere
   * else, which is what this does.
   *
   * The intake grant is then asserted on its own below, both ways, because a
   * default of TRUE is a real and easily-forgotten widening of every scope.
   */
  await db.insert(clientTagAssignments).values([
    { userId: mineId, tagId: tag.id },
    { userId: theirsId, tagId: otherTag.id },
  ]);
  await db.insert(adminClientTagScopes).values({
    adminId: scopedAdmin.id,
    tagId: tag.id,
    createdBy: scopedAdmin.id,
  });

  /*
   * THE OTHER SIDE OF THE BOUNDARY IS FULLY POPULATED. Every row below exists
   * only so that a leak would have something to leak.
   */
  const { rows: wallets } = await db.execute<{ user_id: string; wallet_number: string }>(sql`
    INSERT INTO wallets (user_id, currency, kind, balance) VALUES
      (${mineId}, 'USD', 'main', '100'),
      (${theirsId}, 'USD', 'main', '900')
    RETURNING user_id, wallet_number
  `);
  theirWalletNumber = wallets.find((w) => w.user_id === theirsId)!.wallet_number;

  await db.execute(sql`
    INSERT INTO trading_accounts (user_id, login, currency, environment) VALUES
      (${mineId}, ${MY_LOGIN}, 'USD', 'live'),
      (${theirsId}, ${THEIR_LOGIN}, 'USD', 'live')
  `);

  await db.execute(sql`
    INSERT INTO ledger_entries
      (wallet_id, entry_type, amount, balance_after, reference_type, reference_id)
    SELECT id, 'deposit', balance, balance, 'manual', gen_random_uuid()::text FROM wallets
  `);

  await db.execute(sql`
    INSERT INTO audit_log (actor_id, actor_email, actor_kind, action, subject_type, subject_id)
    VALUES
      (${theirsId}, 'someone@oxshare.com', 'admin', 'client.suspend', 'user', ${theirsId}),
      (${mineId}, 'someone@oxshare.com', 'admin', 'client.suspend', 'user', ${mineId})
  `);

  scoped = await actingAs(ctx, 'admin', SCOPED);
  master = await actingAs(ctx, 'admin', MASTER);
}, 300_000);

afterAll(async () => {
  await stopHttpTestApp(ctx);
});

describe('the fixture has something to leak', () => {
  it('the out-of-scope client owns a wallet, an account, a ledger row and a trail', async () => {
    // Every "the scoped admin saw nothing" below is only meaningful because
    // this says there WAS something to see.
    const { rows } = await ctx.db.db.execute<{ w: string; t: string; l: string; a: string }>(sql`
      SELECT
        (SELECT count(*) FROM wallets WHERE user_id = ${theirsId}) AS w,
        (SELECT count(*) FROM trading_accounts WHERE user_id = ${theirsId}) AS t,
        (SELECT count(*) FROM ledger_entries le
           JOIN wallets w2 ON w2.id = le.wallet_id WHERE w2.user_id = ${theirsId}) AS l,
        (SELECT count(*) FROM audit_log WHERE subject_id = ${theirsId}) AS a
    `);
    expect(Number(rows[0].w)).toBe(1);
    expect(Number(rows[0].t)).toBe(1);
    expect(Number(rows[0].l)).toBe(1);
    expect(Number(rows[0].a)).toBe(1);
  });

  it('a MASTER admin can reach all of it, so the scoped misses are about scope', async () => {
    const wallets = await master.get(`/v1/admin/wallets?q=${theirWalletNumber}&limit=100`);
    expect(items(wallets.body).length).toBe(1);

    const accounts = await master.get(`/v1/admin/trading-accounts?q=${THEIR_LOGIN}&limit=100`);
    expect(items(accounts.body).length).toBe(1);

    const named = await master.get(`/v1/admin/clients?q=${THEIRS.first}&limit=100`);
    expect(items(named.body).length).toBe(1);
  });
});

describe('the SEARCH cannot reach outside the territory', () => {
  it('a client search by name finds nobody outside it', async () => {
    const res = await scoped.get(`/v1/admin/clients?q=${THEIRS.first}&limit=100`);
    expect(res.status).toBe(200);
    expect(items(res.body), 'the client search crossed the boundary').toHaveLength(0);
  });

  it('a client search by their EMAIL finds nobody either', async () => {
    // The sharpest form for a person: the caller already knows the address and
    // is asking the system to confirm it exists.
    const res = await scoped.get(`/v1/admin/clients?q=${THEIRS.email}&limit=100`);
    expect(res.status).toBe(200);
    expect(items(res.body)).toHaveLength(0);
  });

  it('a wallet search by OWNER NAME finds nothing outside it', async () => {
    const res = await scoped.get(`/v1/admin/wallets?q=${THEIRS.first}&limit=100`);
    expect(res.status).toBe(200);
    expect(items(res.body)).toHaveLength(0);
  });

  it('a wallet search by WALLET NUMBER finds nothing outside it', async () => {
    /*
     * THE SHARPEST PROBE IN THE FILE, and the newest.
     *
     * The caller names exactly one row by its identifier and asks whether it
     * exists. An identifier match that skipped the scope predicate would be a
     * scope escape with a single request and no trace — and it would look
     * exactly like the feature working.
     */
    const res = await scoped.get(`/v1/admin/wallets?q=${theirWalletNumber}&limit=100`);
    expect(res.status).toBe(200);
    expect(items(res.body), 'a wallet number reached outside the territory').toHaveLength(0);
  });

  it('a trading-account search by MT5 LOGIN finds nothing outside it', async () => {
    const res = await scoped.get(`/v1/admin/trading-accounts?q=${THEIR_LOGIN}&limit=100`);
    expect(res.status).toBe(200);
    expect(items(res.body), 'an MT5 login reached outside the territory').toHaveLength(0);
  });

  it('a trading-account search by owner name finds nothing outside it', async () => {
    const res = await scoped.get(`/v1/admin/trading-accounts?q=${THEIRS.first}&limit=100`);
    expect(res.status).toBe(200);
    expect(items(res.body)).toHaveLength(0);
  });

  it('the LEDGER search finds no movements outside it', async () => {
    const res = await scoped.get(`/v1/admin/ledger?q=${THEIRS.first}&limit=100`);
    expect(res.status).toBe(200);
    expect(items(res.body), 'the ledger search crossed the boundary').toHaveLength(0);
  });

  it('and the scoped admin CAN still find their own client by every one of them', async () => {
    /*
     * The other half, and it is not a formality: a scope predicate applied too
     * broadly — or a search that silently returns nothing for everyone — would
     * pass every case above while making the console useless.
     */
    const byName = await scoped.get(`/v1/admin/clients?q=${MINE.first}&limit=100`);
    expect(items(byName.body), 'the scoped admin cannot find their OWN client').toHaveLength(1);

    const wallet = await scoped.get(`/v1/admin/wallets?q=${MINE.first}&limit=100`);
    expect(items(wallet.body)).toHaveLength(1);

    const account = await scoped.get(`/v1/admin/trading-accounts?q=${MY_LOGIN}&limit=100`);
    expect(items(account.body), 'the scoped admin cannot find their own account').toHaveLength(1);

    const ledger = await scoped.get(`/v1/admin/ledger?q=${MINE.first}&limit=100`);
    expect(items(ledger.body)).toHaveLength(1);
  });
});

describe('the COUNTS do not leak what the rows hide', () => {
  it('a wallet list total counts only the territory', async () => {
    /*
     * A pager that says "1–1 of 2" while showing one row has told the reader
     * there is a second client, which is the existence fact the scoping exists
     * to withhold. The count has to carry the same predicate as the rows.
     */
    const res = await scoped.get('/v1/admin/wallets?limit=100&withTotal=true');
    expect(res.status).toBe(200);
    const body = res.body as { items: unknown[]; total?: number };
    expect(body.total, 'the wallet total counted outside the territory').toBe(body.items.length);
  });

  it('a client list total counts only the territory', async () => {
    const res = await scoped.get('/v1/admin/clients?limit=100&withTotal=true');
    const body = res.body as { items: unknown[]; total?: number };
    expect(body.total).toBe(body.items.length);
  });

  it('and a MASTER sees a LARGER total, so the check is not counting nothing', async () => {
    const mine = await scoped.get('/v1/admin/clients?limit=100&withTotal=true');
    const all = await master.get('/v1/admin/clients?limit=100&withTotal=true');
    expect((all.body as { total: number }).total).toBeGreaterThan(
      (mine.body as { total: number }).total,
    );
  });
});

describe('the INTAKE POOL — an untriaged client, and the flag that decides', () => {
  /*
   * D-60. `admins.sees_untriaged` defaults to TRUE, so a scoped desk also sees
   * clients carrying no tags at all. That is deliberate — completing a triage
   * must not blank the trail of the person who did it, and somebody has to be
   * able to see a brand-new registration before anyone has classified it — but
   * it is a WIDENING of every scope, by default, and it is worth stating out
   * loud rather than leaving in a migration note.
   *
   * Both directions are asserted, because only the pair distinguishes "the flag
   * works" from "the predicate ignores tags".
   */
  it('a scoped admin WITH the intake grant sees a client nobody has triaged', async () => {
    const res = await scoped.get(`/v1/admin/clients?q=${UNTRIAGED.first}&limit=100`);
    expect(res.status).toBe(200);
    const found = items(res.body) as { id: string }[];
    expect(found, 'the intake pool is not reaching the desk that triages it').toHaveLength(1);
    // The right person, not merely a person — the search term is distinctive,
    // so a filter matching everything would pass the length check alone.
    expect(found[0].id).toBe(untriagedId);
  });

  it('and does NOT see one triaged into another desk’s territory', async () => {
    // The contrast that makes the case above a grant rather than a hole.
    const res = await scoped.get(`/v1/admin/clients?q=${THEIRS.first}&limit=100`);
    expect(items(res.body)).toHaveLength(0);
  });

  it('WITHOUT the grant, the untriaged client disappears too', async () => {
    await ctx.db.db.execute(sql`
      UPDATE admins SET sees_untriaged = false WHERE email = ${SCOPED.email}
    `);
    try {
      // A fresh session: the scope is resolved from the row at authentication.
      const narrowed = await actingAs(ctx, 'admin', SCOPED);
      const res = await narrowed.get(`/v1/admin/clients?q=${UNTRIAGED.first}&limit=100`);
      expect(res.status).toBe(200);
      expect(
        items(res.body),
        'the intake grant does nothing — every scope is wider than it says',
      ).toHaveLength(0);

      // And their own client is still reachable, so this narrowed the scope
      // rather than breaking the query.
      const mineRes = await narrowed.get(`/v1/admin/clients?q=${MINE.first}&limit=100`);
      expect(items(mineRes.body)).toHaveLength(1);
    } finally {
      await ctx.db.db.execute(sql`
        UPDATE admins SET sees_untriaged = true WHERE email = ${SCOPED.email}
      `);
    }
  });
});

describe('the AUDIT TRAIL respects the territory, including its new filters', () => {
  it('the trail of an out-of-scope client is not readable by subject id', async () => {
    /*
     * `subjectId` is new, and a filter added to a scoped list is a new way to
     * ask the same forbidden question. D-54 says client-subject rows follow the
     * reader's territory; this is that rule against the filter rather than
     * against the unfiltered page.
     */
    const res = await scoped.get(`/v1/admin/audit-log?subjectId=${theirsId}&limit=100`);
    expect(res.status).toBe(200);
    expect(items(res.body), 'an out-of-scope client’s trail was readable').toHaveLength(0);
  });

  it('the scoped admin CAN read their own client’s trail', async () => {
    const res = await scoped.get(`/v1/admin/audit-log?subjectId=${mineId}&limit=100`);
    expect(res.status).toBe(200);
    expect(items(res.body).length).toBeGreaterThan(0);
  });

  it('a MASTER can read the out-of-scope trail, so the miss is about scope', async () => {
    const res = await master.get(`/v1/admin/audit-log?subjectId=${theirsId}&limit=100`);
    expect(res.status).toBe(200);
    expect(items(res.body).length).toBe(1);
  });

  it('the unfiltered trail still hides the out-of-scope client’s rows', async () => {
    const res = await scoped.get('/v1/admin/audit-log?limit=100');
    expect(res.status).toBe(200);
    const subjects = rowsOf(res.body).map((r) => r['subjectId']);
    expect(subjects, 'an out-of-scope subject appeared on the unfiltered page').not.toContain(
      theirsId,
    );
  });
});
