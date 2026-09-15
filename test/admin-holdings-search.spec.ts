import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { ALL_PERMISSIONS } from './support/all-permissions';
import { actingAs, startHttpTestApp, stopHttpTestApp, type HttpTestContext } from './http-setup';
import { PasswordService } from '../src/common/security/password.service';
import { admins, roles } from '../src/database/schema';

/**
 * ONE SEARCH BOX, AND IT FINDS EITHER THING THE ROW SHOWS.
 *
 * ## The question behind this file
 *
 * The owner asked it plainly: *"if I am on the wallets page I am supposed to
 * search for a wallet number, right? Same on trading accounts."* Yes — and the
 * box did not. It searched the OWNER only, while every row also displays a
 * wallet number or an MT5 login. That is the same defect that started this
 * whole thread in a new place: an identifier printed on screen that the filter
 * beside it will not accept.
 *
 * ## Why the term is ROUTED rather than OR-ed
 *
 * The two identifiers live in different tables. Postgres cannot BitmapOr across
 * a join, so `owner ILIKE … OR wallet_number = …` defeats the index on BOTH
 * sides and hash-joins every client on every keystroke. Routing by shape keeps
 * each branch a single-table predicate that an index can serve, and the shapes
 * do not overlap: a wallet number is twelve characters from an alphabet with
 * i/l/o/u removed, an MT5 login is all digits, and a person is neither.
 *
 * The cases below are about the ROUTING being right in both directions — the
 * identifier finding its row, AND a name still finding people. A router that
 * sent everything one way would pass half of them.
 */

const MASTER = { email: 'holdings-search@oxshare.com', password: 'admin-password-123' };

let ctx: HttpTestContext;
let alexandraId: string;
let bruceId: string;
let alexandraWallet: string;
let bruceWallet: string;

const LIVE_LOGIN = '00012345';
const OTHER_LOGIN = '99987654';

/* A row names its owner as a nested `user`, not a flat `userId` — the list
   shows who the wallet belongs to, so the person arrives as an object. */
interface WalletRow {
  id: string;
  walletNumber: string;
  user: { id: string; email: string | null };
}
interface AccountRow {
  id: string;
  login: string | null;
  user: { id: string; email: string | null };
}

beforeAll(async () => {
  ctx = await startHttpTestApp();
  const db = ctx.db.db;
  const passwords = new PasswordService();

  const [masterRole] = await db
    .insert(roles)
    .values({ name: 'Holdings Search Master', permissions: ALL_PERMISSIONS, isSystem: true })
    .returning();
  await db.insert(admins).values({
    email: MASTER.email,
    passwordHash: await passwords.hash(MASTER.password),
    name: 'Holdings Master',
    role: 'master_admin',
    roleId: masterRole.id,
    permissions: ALL_PERMISSIONS,
    status: 'active',
  });

  // TWO clients, deliberately: a search over one passes whatever it does.
  const { rows: people } = await ctx.db.db.execute<{ id: string }>(sql`
    INSERT INTO users (email, password_hash, first_name, last_name) VALUES
      ('holdings-alexandra@oxshare-e2e.test', 'x', 'Alexandra', 'Nolan'),
      ('holdings-bruce@oxshare-e2e.test', 'x', 'Bruce', 'Tan')
    RETURNING id
  `);
  alexandraId = people[0].id;
  bruceId = people[1].id;

  // `wallet_number` defaults from the `wallet_number()` function — the real
  // generator, so the format this file matches on is the shipped one.
  const { rows: made } = await ctx.db.db.execute<{ user_id: string; wallet_number: string }>(sql`
    INSERT INTO wallets (user_id, currency, kind, balance) VALUES
      (${alexandraId}, 'USD', 'main', '100'),
      (${bruceId}, 'USD', 'main', '200')
    RETURNING user_id, wallet_number
  `);
  alexandraWallet = made.find((r) => r.user_id === alexandraId)!.wallet_number;
  bruceWallet = made.find((r) => r.user_id === bruceId)!.wallet_number;

  await ctx.db.db.execute(sql`
    INSERT INTO trading_accounts (user_id, login, currency, environment) VALUES
      (${alexandraId}, ${LIVE_LOGIN}, 'USD', 'live'),
      (${bruceId}, ${OTHER_LOGIN}, 'USD', 'live')
  `);
}, 180_000);

afterAll(async () => {
  await stopHttpTestApp(ctx);
});

describe('the wallets desk finds a wallet by its NUMBER', () => {
  it('the generated number matches the shape the router tests for', () => {
    /*
     * The router and `wallets_wallet_number_format` are kept in step by hand.
     * If the constraint's alphabet or length ever changes without the regex
     * changing with it, every number would be routed to the NAME search and
     * find nothing — silently. This is the case that says so.
     */
    expect(alexandraWallet).toMatch(/^[0-9a-hjkmnp-tv-z]{12}$/);
  });

  it('the fixture holds more than one wallet, so a filter can be wrong', async () => {
    const admin = await actingAs(ctx, 'admin', MASTER);
    const res = await admin.get('/v1/admin/wallets?limit=100&withTotal=true');
    expect(res.status).toBe(200);
    expect((res.body as { items: WalletRow[] }).items.length).toBeGreaterThanOrEqual(2);
  });

  it('finds exactly the wallet whose number was typed', async () => {
    const admin = await actingAs(ctx, 'admin', MASTER);
    const res = await admin.get(`/v1/admin/wallets?q=${alexandraWallet}&limit=100`);
    expect(res.status).toBe(200);
    const items = (res.body as { items: WalletRow[] }).items;
    expect(items.length).toBe(1);
    expect(items[0].walletNumber).toBe(alexandraWallet);
    expect(items[0].user.id).toBe(alexandraId);
  });

  it('is case-insensitive, because a number pasted from a ticket may be upper', async () => {
    const admin = await actingAs(ctx, 'admin', MASTER);
    const res = await admin.get(`/v1/admin/wallets?q=${alexandraWallet.toUpperCase()}&limit=100`);
    expect(res.status).toBe(200);
    expect((res.body as { items: WalletRow[] }).items.length).toBe(1);
  });

  it('STILL finds a person by name — the other half of the routing', async () => {
    // A router that sent everything to the identifier branch would pass every
    // case above and break the search the box was originally built for.
    const admin = await actingAs(ctx, 'admin', MASTER);
    const res = await admin.get('/v1/admin/wallets?q=Alexandra&limit=100');
    expect(res.status).toBe(200);
    const items = (res.body as { items: WalletRow[] }).items;
    expect(items.length).toBe(1);
    expect(items[0].user.id).toBe(alexandraId);
  });

  it('answers nothing for a well-formed number that belongs to nobody', async () => {
    // Not "everything": a dropped predicate turns "no such wallet" into the
    // whole platform, which reads as a working filter.
    const admin = await actingAs(ctx, 'admin', MASTER);
    const res = await admin.get('/v1/admin/wallets?q=abcdefghjkmn&limit=100');
    expect(res.status).toBe(200);
    expect((res.body as { items: WalletRow[] }).items.length).toBe(0);
  });

  it('does not leak the other client’s wallet on a number search', async () => {
    const admin = await actingAs(ctx, 'admin', MASTER);
    const res = await admin.get(`/v1/admin/wallets?q=${bruceWallet}&limit=100`);
    const items = (res.body as { items: WalletRow[] }).items;
    expect(items.length).toBe(1);
    expect(items[0].user.id).toBe(bruceId);
  });
});

describe('the trading desk finds an account by its LOGIN', () => {
  it('finds exactly the account whose login was typed', async () => {
    const admin = await actingAs(ctx, 'admin', MASTER);
    const res = await admin.get(`/v1/admin/trading-accounts?q=${LIVE_LOGIN}&limit=100`);
    expect(res.status).toBe(200);
    const items = (res.body as { items: AccountRow[] }).items;
    expect(items.length).toBe(1);
    expect(items[0].login).toBe(LIVE_LOGIN);
  });

  it('keeps LEADING ZEROS significant — they are a different account', async () => {
    /*
     * `login` is a string for exactly this reason: the bridge treats `00012345`
     * and `12345` as different accounts, and parsing the term as a number would
     * silently merge them. Searching for the un-padded form must find nothing.
     */
    const admin = await actingAs(ctx, 'admin', MASTER);
    const res = await admin.get('/v1/admin/trading-accounts?q=12345&limit=100');
    expect(res.status).toBe(200);
    expect((res.body as { items: AccountRow[] }).items.length).toBe(0);
  });

  it('STILL finds a person by name', async () => {
    const admin = await actingAs(ctx, 'admin', MASTER);
    const res = await admin.get('/v1/admin/trading-accounts?q=Bruce&limit=100');
    expect(res.status).toBe(200);
    const items = (res.body as { items: AccountRow[] }).items;
    expect(items.length).toBe(1);
    expect(items[0].user.id).toBe(bruceId);
  });

  it('finds a person by EMAIL, which contains digits but is not a login', async () => {
    // The routing reads the SHAPE of the whole term, so an address with numbers
    // in it must still reach the person search.
    const admin = await actingAs(ctx, 'admin', MASTER);
    const res = await admin.get(
      '/v1/admin/trading-accounts?q=holdings-alexandra@oxshare-e2e.test&limit=100',
    );
    expect(res.status).toBe(200);
    expect((res.body as { items: AccountRow[] }).items.length).toBe(1);
  });

  it('answers nothing for a login that belongs to nobody', async () => {
    const admin = await actingAs(ctx, 'admin', MASTER);
    const res = await admin.get('/v1/admin/trading-accounts?q=55500011&limit=100');
    expect(res.status).toBe(200);
    expect((res.body as { items: AccountRow[] }).items.length).toBe(0);
  });
});
