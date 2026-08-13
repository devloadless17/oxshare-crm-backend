import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import {
  actingAs,
  anonymous,
  startHttpTestApp,
  stopHttpTestApp,
  type HttpTestContext,
} from './http-setup';
import { PasswordService } from '../src/common/security/password.service';
import {
  parseDays,
  MAX_TREND_DAYS,
  DEFAULT_TREND_DAYS,
} from '../src/modules/admin/admin-stats.service';
import {
  adminClientTagScopes,
  admins,
  clientTagAssignments,
  clientTags,
  roles,
} from '../src/database/schema';

/**
 * The dashboard aggregates — `GET /v1/admin/stats/*`.
 *
 * ## What this file is really about
 *
 * One property matters more than the rest: **a scoped administrator's totals
 * count only their own clients**. Every other assertion here is about a screen
 * being right; that one is about a screen not leaking. A dashboard is not
 * thought of as a client list, which is exactly why an unscoped COUNT could sit
 * on one for a long time — "219,000 clients" tells a sub-admin restricted to one
 * desk the size of a client base they were specifically denied, and nothing
 * errors, and no row records it.
 *
 * So the leak test is built to have TEETH:
 *
 *  - The scoped admin holds EVERY permission the routes require. If an
 *    assertion failed for want of a permission, this file would be reporting
 *    that scoping works when it does not. The only thing constraining them is
 *    territory.
 *  - A MASTER control runs beside every scoped case. "The scoped admin sees a
 *    small number" would pass equally against a system that is simply broken;
 *    the master seeing the LARGER number is what makes the small one meaningful.
 *  - The seeded numbers are deliberately different per bucket (2 in-scope
 *    clients vs 5 out-of-scope, 1 vs 3 withdrawals, and so on), so a predicate
 *    that leaks produces a visibly wrong figure rather than a coincidentally
 *    equal one.
 *
 * Verified to have teeth, not assumed: neutralising every `clientScopePredicate`
 * call in `StatsStore` turns this suite red on six assertions with exactly the
 * out-of-scope numbers arriving where they must not. The experiment and its
 * measured output are recorded at the foot of this file.
 */

const MASTER = { email: 'stats-master@oxshare.com', password: 'admin-password-123' };
/** Territory-limited, but holding every permission these routes ask for. */
const SCOPED = { email: 'stats-scoped@oxshare.com', password: 'admin-password-123' };
/** Holds users.view ONLY — the partial-permission case the overview must serve. */
const CLIENTS_ONLY = { email: 'stats-clients-only@oxshare.com', password: 'admin-password-123' };
/** Holds a permission unrelated to every stats route — must be refused outright. */
const OUTSIDER = { email: 'stats-outsider@oxshare.com', password: 'admin-password-123' };

let ctx: HttpTestContext;

/** Clients carrying the scoped admin's tag. */
const mine: string[] = [];
/** Clients carrying no tag at all — invisible to the scoped admin. */
const theirs: string[] = [];

/** The read keys every stats section needs — not the whole catalog. */
const STATS_PERMISSIONS = [
  'clients.view',
  'kyc.view',
  'kyc.review',
  'withdrawals.view',
  'ib.view',
] as const;

/*
 * ── The response shapes, named ───────────────────────────────────────────────
 *
 * `res.body` is `any` on supertest, so every `body.clients.total` is an unsafe
 * member access the type-aware lint rules warn about — and, worse, a typo in a
 * path (`byStatuses`) silently reads `undefined` and the assertion fails with a
 * message about `undefined` rather than about the field. Declaring the shapes
 * here means the compiler catches the typo and the reader can see what the API
 * is being held to without cross-referencing the DTO file.
 *
 * Deliberately hand-written rather than imported from `dto/stats.dto.ts`: a test
 * that asserts against the same declaration the code is built from proves only
 * that the two files agree. This is a second, independent statement of the
 * contract, which is what makes it worth asserting.
 */
interface Overview {
  clients?: {
    total: number;
    registered: { today: number; thisWeek: number; thisMonth: number };
    byStatus: { active: number; pending: number; suspended: number };
    byVerification: { verified: number; notVerified: number };
  };
  kyc?: { byStatus: Record<string, number> };
  withdrawals?: { byState: { state: string; count: number; totalAmount: string }[] };
  ib?: { applications: Record<string, number>; partners: number };
  sections: string[];
  scoped: boolean;
}

interface Series<P> {
  days: number;
  points: P[];
  scoped: boolean;
}

type RegistrationPoint = { date: string; count: number };
type KycTrendPoint = { date: string; submitted: number; approved: number };
type VolumePoint = { date: string; count: number; totalAmount: string };

/**
 * GET as a given admin, with the response body typed.
 *
 * One helper rather than a cast at forty call sites: a cast repeated is a cast
 * somebody eventually writes differently, and the whole reason for typing these
 * at all is that `any` hides a mistyped field path behind a failure about
 * `undefined`.
 */
async function getAs<T>(
  credentials: { email: string; password: string },
  path: string,
): Promise<{ status: number; body: T }> {
  const session = await actingAs(ctx, 'admin', credentials);
  const res = await session.get(path);
  return { status: res.status, body: res.body as T };
}

const overviewFor = (who: { email: string; password: string }) =>
  getAs<Overview>(who, '/v1/admin/stats/overview');

/** `YYYY-MM-DD` for N days before today, in UTC — the same calendar the API uses. */
function utcDaysAgo(days: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString().slice(0, 10);
}

async function makeAdmin(
  credentials: { email: string; password: string },
  roleName: string,
  permissions: readonly string[],
  role: 'master_admin' | 'sub_admin' = 'sub_admin',
): Promise<string> {
  const db = ctx.db.db;
  const passwords = new PasswordService();
  const [roleRow] = await db
    .insert(roles)
    .values({ name: roleName, permissions: [...permissions] })
    .returning();
  const [adminRow] = await db
    .insert(admins)
    .values({
      email: credentials.email,
      passwordHash: await passwords.hash(credentials.password),
      name: roleName,
      role,
      roleId: roleRow.id,
      permissions: [],
      status: 'active',
    })
    .returning();
  return adminRow.id;
}

/**
 * A client with a controlled `created_at`, plus optional KYC, withdrawal and IB
 * rows — every fixture this suite counts, created in one place so the expected
 * numbers are readable from the seed.
 */
async function makeClient(options: {
  email: string;
  daysAgo: number;
  status?: 'active' | 'pending' | 'suspended';
  verificationLevel?: 0 | 1;
  kyc?: { status: string; submittedDaysAgo?: number; reviewedDaysAgo?: number };
  withdrawal?: { amount: string; state: string; daysAgo: number };
  ibApplication?: 'pending' | 'approved' | 'rejected';
  ibPartner?: boolean;
}): Promise<string> {
  const db = ctx.db.db;
  const { rows } = await db.execute<{ id: string }>(sql`
    INSERT INTO users (email, password_hash, first_name, last_name, status, verification_level, created_at)
    VALUES (
      ${options.email}, 'x', 'Stats', 'Client',
      ${options.status ?? 'active'}::user_status,
      ${options.verificationLevel ?? 0},
      (now() AT TIME ZONE 'UTC')::date - make_interval(days => ${options.daysAgo}) + interval '6 hours'
    )
    RETURNING id
  `);
  const userId = rows[0].id;

  if (options.kyc) {
    await db.execute(sql`
      INSERT INTO kyc_submissions (user_id, status, submitted_at, reviewed_at)
      VALUES (
        ${userId}, ${options.kyc.status}::kyc_status,
        ${
          options.kyc.submittedDaysAgo === undefined
            ? sql`NULL`
            : sql`(now() AT TIME ZONE 'UTC')::date - make_interval(days => ${options.kyc.submittedDaysAgo}) + interval '6 hours'`
        },
        ${
          options.kyc.reviewedDaysAgo === undefined
            ? sql`NULL`
            : sql`(now() AT TIME ZONE 'UTC')::date - make_interval(days => ${options.kyc.reviewedDaysAgo}) + interval '6 hours'`
        }
      )
    `);
  }

  if (options.withdrawal) {
    // A wallet first: `transactions.wallet_id` is NOT NULL with an FK.
    const { rows: walletRows } = await db.execute<{ id: string }>(sql`
      INSERT INTO wallets (user_id, currency, balance)
      VALUES (${userId}, 'USD', '0')
      RETURNING id
    `);
    await db.execute(sql`
      INSERT INTO transactions (user_id, wallet_id, direction, amount, currency, state, provider, provider_ref, created_at)
      VALUES (
        ${userId}, ${walletRows[0].id}, 'withdrawal',
        ${options.withdrawal.amount}, 'USD',
        ${options.withdrawal.state}::transaction_state,
        'manual', ${`stats-${userId}`},
        (now() AT TIME ZONE 'UTC')::date - make_interval(days => ${options.withdrawal.daysAgo}) + interval '6 hours'
      )
    `);
  }

  if (options.ibApplication) {
    await db.execute(sql`
      INSERT INTO ib_applications (user_id, status)
      VALUES (${userId}, ${options.ibApplication}::ib_application_status)
    `);
  }

  if (options.ibPartner) {
    await db.execute(sql`
      INSERT INTO ib_accounts (user_id, level, referral_code)
      VALUES (${userId}, (SELECT min(level) FROM ib_levels), ${`STATS-${userId.slice(0, 8)}`})
    `);
  }

  return userId;
}

beforeAll(async () => {
  ctx = await startHttpTestApp();
  const db = ctx.db.db;

  await makeAdmin(MASTER, 'Stats Master', STATS_PERMISSIONS, 'master_admin');
  const scopedAdminId = await makeAdmin(SCOPED, 'Stats Scoped', STATS_PERMISSIONS);
  await makeAdmin(CLIENTS_ONLY, 'Stats Clients Only', ['clients.view']);
  await makeAdmin(OUTSIDER, 'Stats Outsider', ['tags.view']);

  const [tag] = await db
    .insert(clientTags)
    .values({ slug: 'stats-mine', label: 'Stats Mine' })
    .returning();
  await db.insert(adminClientTagScopes).values({
    adminId: scopedAdminId,
    tagId: tag.id,
    createdBy: scopedAdminId,
  });

  /*
   * `ib_levels` must have at least one rung before an `ib_accounts` row can
   * reference one. Inserted defensively — an empty ladder would fail the FK
   * with a message about a level rather than about the fixture.
   */
  await db.execute(sql`
    INSERT INTO ib_levels (level, name, rate_value)
    SELECT 1, 'Stats Level', '10'
    WHERE NOT EXISTS (SELECT 1 FROM ib_levels)
  `);

  /*
   * ── The fixture ───────────────────────────────────────────────────────────
   *
   * IN SCOPE (2 clients, tagged):
   *   mine[0]  registered today,  active,   verified,     KYC approved (submitted 2d, reviewed today)
   *   mine[1]  registered 3d ago, pending,  not verified, KYC submitted (2d ago), withdrawal 100.5 pending 3d ago, IB application pending
   *
   * OUT OF SCOPE (5 clients, untagged):
   *   theirs[0..4] — deliberately MORE numerous than the in-scope set in every
   *   bucket, so a leaking predicate produces a visibly wrong number rather than
   *   a coincidentally equal one.
   *
   * Day 5 is left EMPTY on purpose for both cohorts: it is the zero-fill probe.
   */
  mine.push(
    await makeClient({
      email: 'stats-mine-0@oxshare-e2e.test',
      daysAgo: 0,
      status: 'active',
      verificationLevel: 1,
      kyc: { status: 'approved', submittedDaysAgo: 2, reviewedDaysAgo: 0 },
    }),
    await makeClient({
      email: 'stats-mine-1@oxshare-e2e.test',
      daysAgo: 3,
      status: 'pending',
      verificationLevel: 0,
      kyc: { status: 'submitted', submittedDaysAgo: 2 },
      withdrawal: { amount: '100.50000000', state: 'pending', daysAgo: 3 },
      ibApplication: 'pending',
    }),
  );
  for (const id of mine) {
    await db.insert(clientTagAssignments).values({ userId: id, tagId: tag.id });
  }

  theirs.push(
    await makeClient({
      email: 'stats-theirs-0@oxshare-e2e.test',
      daysAgo: 0,
      status: 'active',
      verificationLevel: 1,
      kyc: { status: 'approved', submittedDaysAgo: 1, reviewedDaysAgo: 0 },
      ibPartner: true,
    }),
    await makeClient({
      email: 'stats-theirs-1@oxshare-e2e.test',
      daysAgo: 1,
      status: 'suspended',
      kyc: { status: 'rejected', submittedDaysAgo: 1, reviewedDaysAgo: 1 },
      withdrawal: { amount: '2000.00000000', state: 'approved', daysAgo: 1 },
    }),
    await makeClient({
      email: 'stats-theirs-2@oxshare-e2e.test',
      daysAgo: 2,
      status: 'active',
      withdrawal: { amount: '300.25000000', state: 'pending', daysAgo: 3 },
      ibApplication: 'approved',
    }),
    await makeClient({
      email: 'stats-theirs-3@oxshare-e2e.test',
      daysAgo: 3,
      status: 'active',
      kyc: { status: 'under_review', submittedDaysAgo: 3 },
    }),
    await makeClient({
      email: 'stats-theirs-4@oxshare-e2e.test',
      daysAgo: 4,
      status: 'pending',
      withdrawal: { amount: '50.00000000', state: 'rejected', daysAgo: 4 },
      ibApplication: 'rejected',
    }),
  );
}, 180_000);

afterAll(async () => {
  await stopHttpTestApp(ctx);
});

// ── parseDays, as a unit ─────────────────────────────────────────────────────

describe('parseDays — R-2.5, a bad window is a 400 naming the range', () => {
  it('defaults when absent or empty, because omitting is not the same as mis-stating', () => {
    expect(parseDays(undefined)).toBe(DEFAULT_TREND_DAYS);
    expect(parseDays('')).toBe(DEFAULT_TREND_DAYS);
    expect(parseDays('   ')).toBe(DEFAULT_TREND_DAYS);
  });

  it('accepts the whole legal range', () => {
    expect(parseDays('1')).toBe(1);
    expect(parseDays('30')).toBe(30);
    expect(parseDays(String(MAX_TREND_DAYS))).toBe(MAX_TREND_DAYS);
  });

  it('REFUSES out of range rather than clamping', () => {
    // A clamp is the tempting shape and it is a lie the UI tells: the operator
    // asks for ten years, gets one, and nothing says the answer is not the
    // question.
    expect(() => parseDays('0')).toThrow(/between 1 and 365/);
    expect(() => parseDays('366')).toThrow(/between 1 and 365/);
    expect(() => parseDays('-5')).toThrow(/between 1 and 365/);
  });

  it('REFUSES trailing junk rather than parsing a prefix', () => {
    // `parseInt('30abc')` is 30 and `parseInt('3.9')` is 3 — both accept input
    // the caller did not mean, and the second silently changes the window.
    for (const bad of ['30abc', '3.9', 'thirty', '1e3', ' 30 x']) {
      expect(() => parseDays(bad), `${bad} was accepted`).toThrow();
    }
  });
});

// ── /admin/stats/overview ────────────────────────────────────────────────────

describe('GET /admin/stats/overview', () => {
  it('counts a master admin against the whole seeded fixture', async () => {
    const { status, body } = await overviewFor(MASTER);

    expect(status).toBe(200);
    expect(body.scoped).toBe(false);
    expect(body.sections).toEqual(['clients', 'kyc', 'withdrawals', 'ib']);

    // 7 seeded clients. `toBeGreaterThanOrEqual` and not `toBe`: this suite owns
    // its own database (money-setup creates one per file), but asserting an
    // exact platform total would still couple the test to every row a future
    // fixture adds — and the property under test is not "the total is 7".
    expect(body.clients?.total).toBeGreaterThanOrEqual(7);
    expect(body.clients?.byStatus.suspended).toBe(1);
    expect(body.clients?.byStatus.pending).toBe(2);
    expect(body.clients?.byVerification.verified).toBe(2);
  });

  it('SCOPED ADMIN SEES ONLY THEIR OWN CLIENTS — the leak test', async () => {
    /*
     * The property this whole file exists for.
     *
     * 2 tagged clients against 5 untagged ones. A predicate that leaks reports
     * 7, and the numbers were chosen so that it cannot report 2 by accident.
     */
    const { status, body } = await overviewFor(SCOPED);

    expect(status).toBe(200);
    expect(body.clients?.total).toBe(2);
    // Stated, so a screen can say "your clients" rather than implying a
    // platform figure.
    expect(body.scoped).toBe(true);

    expect(body.clients?.byStatus.active).toBe(1);
    expect(body.clients?.byStatus.pending).toBe(1);
    // The out-of-scope cohort holds the only suspended client. Seeing 1 here
    // would be the leak.
    expect(body.clients?.byStatus.suspended).toBe(0);
    expect(body.clients?.byVerification.verified).toBe(1);
    expect(body.clients?.byVerification.notVerified).toBe(1);
  });

  it('the master control: the same numbers are LARGER unscoped', async () => {
    // Without this, "the scoped admin sees 2" would pass just as well against a
    // dashboard that is simply broken for sub-admins.
    const master = (await overviewFor(MASTER)).body;
    const scoped = (await overviewFor(SCOPED)).body;

    expect(master.clients!.total).toBeGreaterThan(scoped.clients!.total);
    expect(master.clients!.byStatus.suspended).toBeGreaterThan(scoped.clients!.byStatus.suspended);
  });

  it('scopes the KYC, withdrawal and IB sections too, not only the client one', async () => {
    // A dashboard that scoped its headline client count and leaked the KYC
    // queue depth would be the same defect wearing a different tile.
    const { body } = await overviewFor(SCOPED);

    // In scope: one approved, one submitted. Out of scope: rejected,
    // under_review and a second approved — none may appear.
    expect(body.kyc?.byStatus['approved']).toBe(1);
    expect(body.kyc?.byStatus['submitted']).toBe(1);
    expect(body.kyc?.byStatus['rejected']).toBe(0);
    expect(body.kyc?.byStatus['under_review']).toBe(0);

    const pending = body.withdrawals?.byState.find((s) => s.state === 'pending');
    expect(pending?.count).toBe(1);
    expect(pending?.totalAmount).toBe('100.50000000');

    expect(body.ib?.applications['pending']).toBe(1);
    expect(body.ib?.applications['approved']).toBe(0);
    // The only partner is out of scope.
    expect(body.ib?.partners).toBe(0);
  });

  it('returns ALL SIX kyc statuses, zeroes included', async () => {
    // A status with no submissions must be 0 and not absent — absent and zero
    // look identical to a chart and mean opposite things to a reviewer.
    const { body } = await overviewFor(MASTER);

    expect(Object.keys(body.kyc!.byStatus).sort()).toEqual([
      'approved',
      'in_progress',
      'not_started',
      'rejected',
      'submitted',
      'under_review',
    ]);
    expect(body.kyc?.byStatus['not_started']).toBe(0);
    expect(body.kyc?.byStatus['in_progress']).toBe(0);
  });

  it('returns EVERY transaction state, with money as unmodified strings', async () => {
    const { body } = await overviewFor(MASTER);
    const byState = body.withdrawals!.byState;

    expect(byState.map((s) => s.state).sort()).toEqual([
      'approved',
      'failure',
      'pending',
      'rejected',
      'success',
    ]);

    for (const bucket of byState) {
      // The type IS the assertion. A number here means somebody put a Number()
      // or a JSON-parsed float on the path, and 12345678901234567.89 is already
      // wrong by the time anyone looks at it.
      expect(typeof bucket.totalAmount).toBe('string');
    }

    // 100.50 + 300.25 across the two pending withdrawals, at the column's full
    // NUMERIC(28,8) scale — not '400.75', and not the number 400.75.
    const pending = byState.find((s) => s.state === 'pending');
    expect(pending?.totalAmount).toBe('400.75000000');
    expect(pending?.count).toBe(2);

    // A state with no rows is '0', never null — a tile rendering "—" for a
    // quiet state is worse than one rendering zero.
    const failure = byState.find((s) => s.state === 'failure');
    expect(failure?.count).toBe(0);
    expect(failure?.totalAmount).toBe('0');
  });

  it('OMITS the sections an admin may not see, rather than zeroing them', async () => {
    /*
     * The absent-vs-zero contract. "0 pending KYC" shown to somebody who may
     * not see KYC at all is a confident lie that renders identically to the
     * truth, and a compliance screen is the worst place to put one.
     */
    const { status, body } = await overviewFor(CLIENTS_ONLY);

    expect(status).toBe(200);
    expect(body.sections).toEqual(['clients']);
    expect(body.clients).toBeDefined();
    expect(body.kyc).toBeUndefined();
    expect(body.withdrawals).toBeUndefined();
    expect(body.ib).toBeUndefined();
  });

  it('refuses an admin holding none of the four permissions', async () => {
    const { status } = await overviewFor(OUTSIDER);
    expect(status).toBe(403);
  });

  it('refuses an anonymous caller', async () => {
    // 401 and not 403: there is no session at all, which is a different answer
    // from "your session may not do this" and the admin client acts on the
    // difference (it logs out on a 401 and shows a panel on a 403).
    const res = await anonymous(ctx).get('/v1/admin/stats/overview');
    expect(res.status).toBe(401);
  });
});

// ── /admin/stats/registrations ───────────────────────────────────────────────

describe('GET /admin/stats/registrations', () => {
  const registrations = (who: { email: string; password: string }, query = '') =>
    getAs<Series<RegistrationPoint>>(who, `/v1/admin/stats/registrations${query}`);

  it('returns exactly `days` points, oldest first, with no gaps', async () => {
    const { status, body } = await registrations(MASTER, '?days=7');

    expect(status).toBe(200);
    expect(body.days).toBe(7);
    expect(body.points).toHaveLength(7);

    const dates = body.points.map((p) => p.date);
    expect(dates[0]).toBe(utcDaysAgo(6));
    expect(dates[6]).toBe(utcDaysAgo(0));
    // Sorted and unique — a chart plots these in array order, so an unsorted
    // series draws the line backwards over itself.
    expect([...dates].sort()).toEqual(dates);
    expect(new Set(dates).size).toBe(7);
  });

  it('ZERO-FILLS a day with no registrations rather than omitting it', async () => {
    /*
     * Day 5 is empty in the fixture, on purpose. If it came back missing, a line
     * chart would draw straight from day 6 to day 4 and show steady signups
     * through a day nobody signed up — and the operator has no way to see that
     * the data is missing rather than flat.
     */
    const { body } = await registrations(MASTER, '?days=7');

    const emptyDay = body.points.find((p) => p.date === utcDaysAgo(5));
    expect(emptyDay, 'the empty day was omitted entirely').toBeDefined();
    expect(emptyDay?.count).toBe(0);
  });

  it('defaults to 30 days when no window is given', async () => {
    const { body } = await registrations(MASTER);
    expect(body.days).toBe(DEFAULT_TREND_DAYS);
    expect(body.points).toHaveLength(DEFAULT_TREND_DAYS);
  });

  it('counts the seeded registrations on the right days', async () => {
    const { body } = await registrations(MASTER, '?days=7');
    const on = (daysAgo: number): number | undefined =>
      body.points.find((p) => p.date === utcDaysAgo(daysAgo))?.count;

    // Two clients registered today (mine[0], theirs[0]) and nothing else — the
    // admin fixtures are `admins` rows, not `users`, so they do not count here.
    expect(on(0)).toBe(2);
    expect(on(1)).toBe(1);
    expect(on(3)).toBe(2);
  });

  it('SCOPED ADMIN gets only their own clients in the series — the leak test', async () => {
    const scoped = (await registrations(SCOPED, '?days=7')).body;
    const master = (await registrations(MASTER, '?days=7')).body;

    const sum = (body: Series<RegistrationPoint>) =>
      body.points.reduce((total, point) => total + point.count, 0);

    expect(scoped.scoped).toBe(true);
    // The two tagged clients and no others.
    expect(sum(scoped)).toBe(2);
    // The control: unscoped is strictly larger, so the small number above is
    // evidence of a working predicate rather than of a broken query.
    expect(sum(master)).toBe(7);

    // And the shape is still complete — scoping must not turn zero-filling off.
    expect(scoped.points).toHaveLength(7);
  });

  it('400s an out-of-range window, naming the range', async () => {
    for (const bad of ['0', '366', '-1', 'abc', '3.5']) {
      const res = await registrations(MASTER, `?days=${bad}`);
      expect(res.status, `days=${bad} answered ${res.status}`).toBe(400);
      // The message must say what IS allowed — R-2.5. A bare "invalid" leaves
      // the caller to guess, and a silent clamp would leave them not even
      // knowing there was something to guess about.
      expect(JSON.stringify(res.body)).toMatch(/365/);
    }
  });

  it('refuses an admin without users.view', async () => {
    const { status } = await registrations(OUTSIDER);
    expect(status).toBe(403);
  });
});

// ── /admin/stats/kyc-trend ───────────────────────────────────────────────────

describe('GET /admin/stats/kyc-trend', () => {
  const kycTrend = (who: { email: string; password: string }, query = '') =>
    getAs<Series<KycTrendPoint>>(who, `/v1/admin/stats/kyc-trend${query}`);

  it('zero-fills and buckets submissions and approvals on their own dates', async () => {
    const { status, body } = await kycTrend(MASTER, '?days=7');

    expect(status).toBe(200);
    expect(body.points).toHaveLength(7);

    const at = (daysAgo: number) => body.points.find((p) => p.date === utcDaysAgo(daysAgo));

    // mine[0] submitted 2d ago and was approved TODAY. The two must land on
    // different days — a submission and its approval are separate events, and
    // collapsing them onto one date is how an approval-rate chart lies.
    expect(at(2)?.submitted).toBeGreaterThanOrEqual(1);
    expect(at(0)?.approved).toBeGreaterThanOrEqual(1);

    // The empty day is present with both counters at zero.
    expect(at(5)).toBeDefined();
    expect(at(5)?.submitted).toBe(0);
    expect(at(5)?.approved).toBe(0);
  });

  it('does NOT count a rejection as an approval', async () => {
    // theirs[1] was reviewed 1 day ago and REJECTED. Counting every review as
    // an approval reads plausibly on a dashboard for months.
    const { body } = await kycTrend(MASTER, '?days=7');
    const yesterday = body.points.find((p) => p.date === utcDaysAgo(1));

    expect(yesterday?.approved).toBe(0);
  });

  it('SCOPED ADMIN gets only their own clients’ KYC trend', async () => {
    const scoped = (await kycTrend(SCOPED, '?days=7')).body;
    const master = (await kycTrend(MASTER, '?days=7')).body;

    const submissions = (body: Series<KycTrendPoint>) =>
      body.points.reduce((t, p) => t + p.submitted, 0);

    // In scope: two submissions, both 2 days ago. Out of scope: three more.
    expect(submissions(scoped)).toBe(2);
    expect(submissions(master)).toBe(5);
    expect(scoped.scoped).toBe(true);
  });

  it('is reachable with kyc.review as well as kyc.view', async () => {
    // Both keys legitimately want the trend, and the service asserts the same
    // disjunction the guard does — R-4.5, the two layers may not disagree.
    const { status } = await kycTrend(SCOPED, '?days=3');
    expect(status).toBe(200);
  });

  it('400s an out-of-range window and 403s an admin without KYC permission', async () => {
    expect((await kycTrend(MASTER, '?days=999')).status).toBe(400);
    expect((await kycTrend(CLIENTS_ONLY)).status).toBe(403);
  });
});

// ── /admin/stats/withdrawal-volume ───────────────────────────────────────────

describe('GET /admin/stats/withdrawal-volume', () => {
  const volume = (who: { email: string; password: string }, query = '') =>
    getAs<Series<VolumePoint>>(who, `/v1/admin/stats/withdrawal-volume${query}`);

  it('returns amounts as unmodified strings at full NUMERIC(28,8) scale', async () => {
    const { status, body } = await volume(MASTER, '?days=7');

    expect(status).toBe(200);
    for (const point of body.points) {
      expect(typeof point.totalAmount).toBe('string');
    }

    // Two withdrawals 3 days ago: 100.50 (in scope) + 300.25 (out of scope).
    // The sum is Postgres's, at the column's scale, and it crosses the wire as
    // text — never '400.75' and never the number 400.75.
    const threeDaysAgo = body.points.find((p) => p.date === utcDaysAgo(3));
    expect(threeDaysAgo?.totalAmount).toBe('400.75000000');
    expect(threeDaysAgo?.count).toBe(2);
  });

  it('zero-fills a quiet day with "0", not null and not absent', async () => {
    const { body } = await volume(MASTER, '?days=7');

    const quiet = body.points.find((p) => p.date === utcDaysAgo(5));
    expect(quiet, 'the quiet day was omitted').toBeDefined();
    expect(quiet?.count).toBe(0);
    expect(quiet?.totalAmount).toBe('0');
    expect(quiet?.totalAmount).not.toBeNull();
  });

  it('SCOPED ADMIN sees only their own clients’ withdrawal money — the leak test', async () => {
    /*
     * The most consequential of the three leaks. Withdrawal volume is a
     * statement about how much money is leaving the platform, and answering it
     * for the WHOLE platform to a desk-restricted admin discloses trading scale
     * they were specifically denied.
     */
    const scoped = (await volume(SCOPED, '?days=7')).body;
    const master = (await volume(MASTER, '?days=7')).body;

    const day = (body: Series<VolumePoint>) => body.points.find((p) => p.date === utcDaysAgo(3));

    // In scope on that day: only mine[1]'s 100.50.
    expect(day(scoped)?.count).toBe(1);
    expect(day(scoped)?.totalAmount).toBe('100.50000000');

    // The control. Unscoped, the same day carries both withdrawals — so the
    // scoped figure above is a working predicate, not a broken query.
    expect(day(master)?.count).toBe(2);
    expect(day(master)?.totalAmount).toBe('400.75000000');

    const total = (body: Series<VolumePoint>) => body.points.reduce((t, p) => t + p.count, 0);
    expect(total(scoped)).toBe(1);
    expect(total(master)).toBe(4);
  });

  it('counts withdrawals only — a deposit must never appear', async () => {
    /*
     * `transactions` holds both directions. A volume tile that silently
     * included deposits would be wrong in the direction that matters: it would
     * overstate money on its way OUT of the platform.
     */
    const db = ctx.db.db;
    const { rows: walletRows } = await db.execute<{ id: string }>(sql`
      SELECT id FROM wallets WHERE user_id = ${mine[1]} LIMIT 1
    `);
    await db.execute(sql`
      INSERT INTO transactions (user_id, wallet_id, direction, amount, currency, state, provider, provider_ref, created_at)
      VALUES (${mine[1]}, ${walletRows[0].id}, 'deposit', '9999.00000000', 'USD', 'success',
              'manual', 'stats-deposit-probe',
              (now() AT TIME ZONE 'UTC')::date - make_interval(days => 3) + interval '6 hours')
    `);

    const { body } = await volume(MASTER, '?days=7');
    const threeDaysAgo = body.points.find((p) => p.date === utcDaysAgo(3));

    // Unchanged by a 9,999 deposit sitting on the same day.
    expect(threeDaysAgo?.totalAmount).toBe('400.75000000');
    expect(threeDaysAgo?.count).toBe(2);

    await db.execute(sql`DELETE FROM transactions WHERE provider_ref = 'stats-deposit-probe'`);
  });

  it('400s an out-of-range window and 403s an admin without withdrawals.view', async () => {
    const bad = await volume(MASTER, '?days=0');
    expect(bad.status).toBe(400);
    expect(JSON.stringify(bad.body)).toMatch(/365/);

    expect((await volume(CLIENTS_ONLY)).status).toBe(403);
  });
});

/*
 * ── PROVING THE LEAK TESTS HAVE TEETH ───────────────────────────────────────
 *
 * A scope test that passes against a broken predicate is worse than no test at
 * all: it reads as a guarantee. So these were verified by breaking the code on
 * purpose and confirming the right assertions go red.
 *
 * THE EXPERIMENT, reproducible: in `src/store/stats.store.ts`, make every
 * `clientScopePredicate(...)` call evaluate to `undefined` — which is exactly
 * what the helper returns for an unrestricted actor, so the scoped admin is
 * silently promoted to seeing everything. Nothing else changes; the file still
 * compiles and every query still runs.
 *
 * RESULT, measured 2026-08-07 — 6 failed, 24 passed:
 *
 *   overview   SCOPED ADMIN SEES ONLY THEIR OWN CLIENTS   expected 7 to be 2
 *   overview   the master control                          expected 7 to be > 7
 *   overview   scopes KYC, withdrawal and IB too           expected 2 to be 1
 *   series     registrations leak test                     expected 7 to be 2
 *   series     kyc-trend leak test                         expected 5 to be 2
 *   series     withdrawal-volume leak test                 expected 2 to be 1
 *
 * Every one of those numbers is the out-of-scope cohort arriving where it must
 * not — 7 clients instead of 2, 5 submissions instead of 2, both withdrawals
 * instead of one. That is the leak, named and caught.
 *
 * Note the second line especially: the master control fails too, and it fails
 * with "expected 7 to be greater than 7". That is the control doing its job —
 * once scoping is off, the scoped and unscoped answers become identical, and a
 * suite that only asserted "the scoped admin sees a small number" would have no
 * way to notice.
 */
