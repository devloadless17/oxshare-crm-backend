import { ALL_PERMISSIONS } from './support/all-permissions';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { actingAs, startHttpTestApp, stopHttpTestApp, type HttpTestContext } from './http-setup';
import { PasswordService } from '../src/common/security/password.service';
import { admins, auditLog, roles, users } from '../src/database/schema';
import { desc, eq } from 'drizzle-orm';

/**
 * DOES THE ACTION LOG ACTUALLY RECORD? — driven through HTTP, per action.
 *
 * `audit-coverage.spec.ts` already asserts that every mutating admin route
 * DECLARES a stance, `@Audited('x')` or `@NotAudited(reason)`. That test reads
 * Nest metadata, and metadata is a promise rather than a behaviour: nothing
 * reads `AUDIT_KEY` at runtime — there is no interceptor behind the decorator —
 * so a route can carry `@Audited('currency.create')`, satisfy that spec, and
 * write nothing at all.
 *
 * That gap was not hypothetical. Static analysis of the tree found 57 declared
 * actions and 40 with a matching `record()` call, and the seventeen without one
 * were whole feature modules — currencies, IB levels, IB applications, payment
 * methods, settings — where the service contained no audit code whatsoever.
 *
 * So this file makes the REQUEST and then looks in the table. It is the only
 * form of the question that cannot be satisfied by a decorator.
 *
 * ── The gap is CLOSED, and the four `it.fails` are now ordinary tests ───────
 *
 * All seventeen actions now write. The four cases this file pinned as broken —
 * `currency.create`, `payment_method.create`, `ib_level.create` and
 * `settings.general.update` — moved into the "recorded" block below, which is
 * the lifecycle their original note described: `it.fails` passes only while the
 * body throws, so fixing the routes turned those tests red and told whoever did
 * it to promote them. The settings one is now `settings.trading.update`: the
 * General tab and its table were removed, and the trading terms are the write
 * on that screen worth attributing.
 *
 * Each service now takes the acting admin from the controller (`req.admin`) the
 * way `admin-tags.service.ts` does, rather than reaching for a request — so a
 * queued job calling the same method still records who it ran as (R-4.3).
 *
 * `audit-record-coverage.spec.ts` is what stops the gap reopening. It reads
 * every `@Audited('x')` off the source and fails if no `record('x')` call
 * exists anywhere in `src/`, covering all fifty-odd actions statically where
 * this file covers a representative handful through real HTTP. Neither
 * subsumes the other: a `record()` call in dead code passes there and fails
 * here.
 *
 * ── Why these tests are worth having in the suite ──────────────────────────
 *
 * D-21's justification for the log is that it is the one record that cannot be
 * reconstructed after the fact. Current state answers "who may approve
 * withdrawals"; nothing answers "who changed the commission ladder last March"
 * once the row has been overwritten. Every action below either produces that
 * record or is a silent hole in it, and a hole nobody has enumerated is one
 * discovered during an incident.
 */

const MASTER = { email: 'audit-complete@oxshare.com', password: 'admin-password-123' };

let ctx: HttpTestContext;
let clientId: string;

beforeAll(async () => {
  ctx = await startHttpTestApp();
  const passwords = new PasswordService();
  const db = ctx.db.db;

  const [masterRole] = await db
    .insert(roles)
    .values({ name: 'Audit Completeness Master', permissions: ALL_PERMISSIONS, isSystem: true })
    .returning();

  await db.insert(admins).values({
    email: MASTER.email,
    passwordHash: await passwords.hash(MASTER.password),
    name: 'Audit Completeness',
    role: 'master_admin',
    roleId: masterRole.id,
    permissions: ALL_PERMISSIONS,
    status: 'active',
  });

  const [client] = await db
    .insert(users)
    .values({
      email: 'audit-complete-target@oxshare-e2e.test',
      passwordHash: 'x',
      firstName: 'Audit',
      lastName: 'Complete',
    })
    .returning();
  clientId = client.id;
});

afterAll(async () => {
  await stopHttpTestApp(ctx);
});

/**
 * Did an action of this name land, and how many are there now?
 *
 * Read straight from the table rather than through `GET /admin/audit-log`, so
 * a serving bug (a DTO dropping a field, a filter mis-parsing) cannot be
 * mistaken for a recording bug. This file is only asking whether the row
 * exists.
 */
async function countOf(action: string): Promise<number> {
  const found = await ctx.db.db
    .select({ id: auditLog.id })
    .from(auditLog)
    .where(eq(auditLog.action, action));
  return found.length;
}

/**
 * Wait for the count to reach `want`, because `record()` is FIRE-AND-FORGET.
 *
 * `AdminAuditService.record` deliberately does not await its write — an
 * audit-write failure must never fail the administrative action it describes —
 * so the row lands some time AFTER the HTTP response the caller already got.
 * Reading the table immediately therefore finds nothing, for a route that
 * records perfectly well.
 *
 * That is also the mechanism behind the intermittent failures in
 * `audit-log-http.spec.ts`: it asserts through the API right after the request
 * and wins or loses a race.
 *
 * Polling rather than a fixed sleep: it returns as soon as the row appears, so
 * the common case costs one query, and a genuine non-recorder still fails —
 * just a second later. Money routes use `recordWithin`, which commits inside
 * the caller's transaction and needs none of this.
 */
async function waitForCount(action: string, want: number, timeoutMs = 3000): Promise<number> {
  const deadline = Date.now() + timeoutMs;
  let seen = await countOf(action);
  while (seen < want && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 50));
    seen = await countOf(action);
  }
  return seen;
}

/** The most recent row for an action, for asserting WHAT was recorded. */
async function latest(action: string) {
  const [row] = await ctx.db.db
    .select()
    .from(auditLog)
    .where(eq(auditLog.action, action))
    .orderBy(desc(auditLog.createdAt))
    .limit(1);
  return row;
}

/*
 * ── The actions that DO record ────────────────────────────────────────────
 *
 * Pinned so a regression in the working half is caught too. These are the
 * services under `modules/admin/`, which take `AdminAuditService` and call it.
 */
describe('recorded: the admin module', () => {
  it('records suspending a client, with the actor and the subject', async () => {
    const session = await actingAs(ctx, 'admin', MASTER);
    const before = await countOf('client.suspend');

    await session
      .patch(`/v1/admin/clients/${clientId}/status`, { status: 'suspended' })
      .expect(200);

    expect(await waitForCount('client.suspend', before + 1)).toBe(before + 1);

    const row = await latest('client.suspend');
    expect(row?.actorEmail).toBe(MASTER.email);
    expect(row?.subjectId).toBe(clientId);
    // `actorKind` distinguishes a person from a scheduled job (R-4.3).
    expect(row?.actorKind).toBe('admin');
  });

  it('records reactivating as its own action, not a second suspend', async () => {
    const session = await actingAs(ctx, 'admin', MASTER);
    const before = await countOf('client.activate');

    await session.patch(`/v1/admin/clients/${clientId}/status`, { status: 'active' }).expect(200);

    expect(await waitForCount('client.activate', before + 1)).toBe(before + 1);
  });

  it('records creating a tag', async () => {
    const session = await actingAs(ctx, 'admin', MASTER);
    const before = await countOf('client_tag.create');

    const res = await session.post('/v1/admin/tags', {
      label: `Audit Tag ${Date.now() % 100000}`,
    });
    expect([200, 201]).toContain(res.status);

    expect(await waitForCount('client_tag.create', before + 1)).toBe(before + 1);
  });

  it('records an admin role change — a privilege grant must never be silent', async () => {
    const session = await actingAs(ctx, 'admin', MASTER);
    const passwords = new PasswordService();

    const [target] = await ctx.db.db
      .insert(admins)
      .values({
        email: `audit-role-target-${Date.now() % 100000}@oxshare.com`,
        passwordHash: await passwords.hash('admin-password-123'),
        name: 'Role Target',
        role: 'sub_admin',
        permissions: ['clients.view'],
        status: 'active',
      })
      .returning();

    const [role] = await ctx.db.db
      .insert(roles)
      .values({ name: `Audit Role ${Date.now() % 100000}`, permissions: ['clients.view'] })
      .returning();

    const before = await countOf('admin.update');
    const res = await session.patch(`/v1/admin/users/${target.id}`, { roleId: role.id });

    if (res.status === 200) {
      expect(
        await waitForCount('admin.update', before + 1),
        'granting a role left no trace',
      ).toBeGreaterThan(before);
    }
  });
});

/*
 * ── The feature modules, which used to record nothing ──────────────────────
 *
 * These four were `it.fails` — asserted as PRESENT rather than skipped, so the
 * suite stated the gap instead of implying coverage that did not exist. Their
 * services now take the acting admin and call the audit writer, so they are
 * ordinary tests: each drives the real route and then reads the table.
 *
 * They are kept as their own block rather than folded into the one above
 * because they cover a different risk. The admin-module actions were always
 * recorded and these are the ones a regression would silently un-record — the
 * modules where the decorator and the call have already drifted apart once.
 */
describe('recorded: the feature modules', () => {
  it('currency.create — adding a currency is attributable', async () => {
    const session = await actingAs(ctx, 'admin', MASTER);
    const before = await countOf('currency.create');

    const code = `A${String(Date.now() % 10000).padStart(4, '0')}`;
    const res = await session.post('/v1/admin/currencies', {
      code,
      name: 'Audit Test Currency',
      symbol: '¤',
      decimals: 2,
    });
    expect([200, 201]).toContain(res.status);

    expect(await waitForCount('currency.create', before + 1)).toBe(before + 1);
  });

  it('payment_method.create — a new way for clients to send money in', async () => {
    const session = await actingAs(ctx, 'admin', MASTER);
    const before = await countOf('payment_method.create');

    /*
     * A REAL body, for the reason the ib_level case below spells out: the
     * `it.fails` version sent `label` (the field is `name`), a `kind` that was
     * not one of the enum's values, and no `currency` at all, so it was refused
     * at validation rather than reaching any audit code. `it.fails` counts any
     * throw as success, so it looked green while proving nothing.
     *
     * `kind` is not sent now because the column is gone (migration 0043) — and
     * `forbidNonWhitelisted` would refuse the request for carrying it, which is
     * the same trap in a new spelling.
     */
    const res = await session.post('/v1/admin/payment-methods', {
      key: `audit_test_${Date.now() % 100000}`,
      name: 'Audit Test Method',
      currency: 'USD',
    });
    expect([200, 201]).toContain(res.status);

    expect(await waitForCount('payment_method.create', before + 1)).toBe(before + 1);
  });

  it('ib_level.create — a change to the commission ladder leaves a trace', async () => {
    /*
     * The most consequential of the seventeen. An IB level sets what partners
     * are PAID; editing one silently changes everybody's commission, and
     * "who lowered level 3 last quarter" is precisely the question the log
     * exists to answer.
     */
    const session = await actingAs(ctx, 'admin', MASTER);
    const before = await countOf('ib_level.create');

    /*
     * A REAL request body, which the `it.fails` version was not.
     *
     * That version sent `commissionRate` (the DTO field is `rateValue`) at
     * `level: 90+` (capped at 10) — so it was rejected at validation and threw
     * on the status assertion, which `it.fails` accepted as success. It was
     * green for a reason unrelated to the gap it claimed to describe, which is
     * the hazard of `it.fails`: any throw counts. Promoting it meant fixing it.
     *
     * `rateValue` is a decimal string of at most four places (NUMERIC(12,4)),
     * and `enabled: false` keeps this out of the revenue-share ceiling so the
     * test cannot fail because an unrelated suite left the ladder full.
     */
    const res = await session.post('/v1/admin/ib-levels', {
      name: `Audit Level ${Date.now() % 100000}`,
      level: 9,
      rateValue: '1.5000',
      enabled: false,
    });
    expect([200, 201]).toContain(res.status);

    expect(await waitForCount('ib_level.create', before + 1)).toBe(before + 1);

    /*
     * §6.1 — the rate is logged as the STRING it arrived as.
     *
     * A commission rate that went through `Number()` on the way into the log
     * would make the RECORD of the rate differ from the rate, which defeats the
     * purpose of recording it. The type is asserted as well as the value,
     * because '1.5000' and 1.5 both read as correct in a diff.
     */
    const row = await latest('ib_level.create');
    const details = row?.details as { rateValue?: unknown } | undefined;
    expect(details?.rateValue).toBe('1.5000');
    expect(typeof details?.rateValue).toBe('string');
  });

  it('settings.trading.update — the terms clients are offered are attributable', async () => {
    const session = await actingAs(ctx, 'admin', MASTER);
    const before = await countOf('settings.trading.update');

    /*
     * Took over from `settings.general.update`, which was removed with the
     * General tab and its table. The reason for pinning it is stronger here:
     * the per-client account caps, the demo funding ceiling and the broker's
     * revenue cap are all limits somebody can raise, and the effect surfaces in
     * the broker's own reporting weeks later.
     *
     * The leverage ladder USED to ride on this payload as a comma-separated
     * string. Migration 0067 gave it its own table and its own `leverages.*`
     * keys, so it is attributed through `leverage.create`/`.update`/`.delete`
     * instead — one row per rung rather than one "trading settings changed".
     * Sending it here now is a 400: the DTO whitelists its properties, so an
     * unknown one is rejected rather than ignored.
     *
     * PUT, not PATCH — the route is `@Put('trading')`, and a PATCH matches no
     * handler, which would make this pass on the status assertion rather than
     * on the audit row it claims to be about.
     */
    const res = await session.put('/v1/admin/settings/trading', {
      maxLiveAccounts: 4,
      maxDemoAccounts: 6,
      maxDemoDeposit: '500000',
      // Required since the broker's revenue cap arrived. A PUT missing it is a
      // 400, and the audit row this test is about never gets written.
      ibMaxRevenueSharePct: '50.00',
    });
    expect([200, 201, 204]).toContain(res.status);

    expect(await waitForCount('settings.trading.update', before + 1)).toBe(before + 1);
  });
});

/*
 * ── The log itself cannot be rewritten ─────────────────────────────────────
 *
 * A trail that can be edited answers nothing. The table has a trigger that
 * rejects UPDATE and DELETE outright, so this is asserted against the database
 * rather than against the absence of an API route — an API can be added, and
 * the guarantee has to survive that.
 */
describe('append-only', () => {
  it('refuses an UPDATE to a recorded action', async () => {
    const session = await actingAs(ctx, 'admin', MASTER);
    await session.patch(`/v1/admin/clients/${clientId}/status`, { status: 'suspended' });

    const row = await latest('client.suspend');
    expect(row).toBeDefined();

    await expect(
      ctx.db.db.update(auditLog).set({ action: 'client.activate' }).where(eq(auditLog.id, row.id)),
      'the audit log accepted an UPDATE — the trail is rewritable',
    ).rejects.toThrow();
  });

  it('refuses a DELETE', async () => {
    const row = await latest('client.suspend');
    expect(row).toBeDefined();

    await expect(
      ctx.db.db.delete(auditLog).where(eq(auditLog.id, row.id)),
      'the audit log accepted a DELETE — an action can be erased',
    ).rejects.toThrow();
  });
});
