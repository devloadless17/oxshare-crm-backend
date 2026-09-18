import { ALL_PERMISSIONS } from './support/all-permissions';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  actingAs,
  startHttpTestApp,
  stopHttpTestApp,
  type HttpTestContext,
  type Session,
} from './http-setup';
import { PasswordService } from '../src/common/security/password.service';
import { admins, roles } from '../src/database/schema';
import { encodeCursor } from '../src/common/pagination';

/**
 * A malformed query value is refused BY NAME, at the edge.
 *
 * ## ⚠️ What this is NOT
 *
 * It is not a 500 fix, and the first version of this file said it was. The
 * audit finding these changes came from described six uuid filters and seven
 * keyset cursors as answering "a 500 carrying a database error". They do not:
 * `AllExceptionsFilter` maps Postgres `22P02` to a 400 `INVALID_IDENTIFIER`,
 * added deliberately after "bad input from a typo'd URL was logged with a full
 * stack as an unexpected server error".
 *
 * That was checked rather than assumed — by deleting the new guards and
 * re-running these cases, which still passed. A test asserting only `400` would
 * have passed before the change, after it, and with it reverted, while reading
 * like proof.
 *
 * ## What actually changed, and what these assert
 *
 * WHICH refusal. "A value in the request is not a valid identifier" is produced
 * by the database after a round trip and cannot name the parameter — on a route
 * taking four ids that leaves a caller guessing, and a stale cursor gets a
 * sentence about identifiers rather than one about cursors.
 *
 * So every case below asserts the SPECIFIC error, not merely a 4xx: the
 * field-level refusal for a filter, and the cursor's own message for a cursor.
 * That is the difference the change makes, so that is what is pinned.
 */

const MASTER = { email: 'shape-master@oxshare.com', password: 'admin-password-123' };

let ctx: HttpTestContext;
let master: Session;

/** Well-formed, and naming nothing — the control for every case below. */
const ABSENT_UUID = '00000000-0000-4000-8000-000000000000';

beforeAll(async () => {
  ctx = await startHttpTestApp();
  const passwords = new PasswordService();
  const [role] = await ctx.db.db
    .insert(roles)
    .values({ name: 'Shape Master', permissions: ALL_PERMISSIONS, isSystem: true })
    .returning();
  await ctx.db.db.insert(admins).values({
    email: MASTER.email,
    passwordHash: await passwords.hash(MASTER.password),
    name: 'Shape Master',
    role: 'master_admin',
    roleId: role.id,
    permissions: ALL_PERMISSIONS,
    status: 'active',
  });
  master = await actingAs(ctx, 'admin', MASTER);
}, 180_000);

afterAll(async () => {
  await stopHttpTestApp(ctx);
});

describe('a uuid filter refuses a malformed value', () => {
  const ROUTES: { name: string; path: (value: string) => string }[] = [
    { name: 'audit log ?actorId', path: (v) => `/v1/admin/audit-log?actorId=${v}` },
    { name: 'audit log export ?actorId', path: (v) => `/v1/admin/audit-log/export?actorId=${v}` },
    { name: 'wallets ?userId', path: (v) => `/v1/admin/wallets?userId=${v}` },
    { name: 'wallets export ?userId', path: (v) => `/v1/admin/wallets/export?userId=${v}` },
    { name: 'trading accounts ?userId', path: (v) => `/v1/admin/trading-accounts?userId=${v}` },
    {
      name: 'trading accounts export ?userId',
      path: (v) => `/v1/admin/trading-accounts/export?userId=${v}`,
    },
    { name: 'ledger ?userId', path: (v) => `/v1/admin/ledger?userId=${v}` },
    { name: 'ledger ?walletId', path: (v) => `/v1/admin/ledger?walletId=${v}` },
    { name: 'accruals ?ibUserId', path: (v) => `/v1/admin/ib/accruals?ibUserId=${v}` },
    { name: 'accruals ?clientUserId', path: (v) => `/v1/admin/ib/accruals?clientUserId=${v}` },
  ];

  it.each(ROUTES)('$name names the parameter it refused', async ({ path }) => {
    const res = await master.get(path('not-a-uuid'));

    expect(res.status).toBe(400);
    /*
     * `VALIDATION_FAILED`, not `INVALID_IDENTIFIER`. The second is what the
     * database produces after the value reaches it, and it cannot say which
     * parameter was wrong. Asserting the code is what makes this test fail if
     * the edge guard is removed — asserting the status alone would not.
     */
    const body = res.body as { code?: string; fields?: Record<string, string> };
    expect(body.code).toBe('VALIDATION_FAILED');
    expect(Object.keys(body.fields ?? {}).length).toBeGreaterThan(0);
  });

  it.each(ROUTES)('$name still ACCEPTS a well-formed id that matches nothing', async ({ path }) => {
    /*
     * The control, and it is not redundant. A guard that refused every value
     * would satisfy every assertion above while breaking the filter entirely —
     * and "no results" for a valid id is a truthful answer, where a 400 would
     * not be.
     */
    const res = await master.get(path(ABSENT_UUID));

    expect(res.status, `${String(res.status)} for a well-formed id`).toBeLessThan(400);
  });
});

describe('a tampered cursor refuses rather than reaching a cast', () => {
  it('refuses a non-uuid row id, on a sort that never checked one', async () => {
    /*
     * `id` was never validated at all, on any sort. Every seek emits
     * `${cursor.id}::uuid`, so this was a guaranteed 22P02 on all seven keyset
     * lists.
     */
    const cursor = encodeCursor({ sort: 'createdAt', value: new Date().toISOString(), id: 'nope' });

    const res = await master.get(`/v1/admin/wallets?cursor=${cursor}`);

    expect(res.status).toBe(400);
    // The cursor's own message, which tells the caller what to do. Without the
    // guard this is the database's generic identifier complaint instead.
    expect((res.body as { message?: string }).message).toMatch(/cursor/i);
  });

  it('refuses a non-numeric value on a NUMERIC sort', async () => {
    // The case the old check could not see: it validated the value only when the
    // sort was `createdAt`, so `?sort=balance` carried anything into `::numeric`.
    const cursor = encodeCursor({ sort: 'balance', value: 'not-a-number', id: ABSENT_UUID });

    const res = await master.get(`/v1/admin/wallets?sort=balance&cursor=${cursor}`);

    expect(res.status).toBe(400);
    expect((res.body as { message?: string }).message).toMatch(/cursor/i);
  });

  it('still accepts a well-formed cursor', async () => {
    // The control again: a decoder that refused everything would pass both cases
    // above and break paging on every list.
    const cursor = encodeCursor({ sort: 'balance', value: '10.5', id: ABSENT_UUID });

    const res = await master.get(`/v1/admin/wallets?sort=balance&cursor=${cursor}`);

    expect(res.status).toBeLessThan(400);
  });
});
