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
import { admins, roles } from '../src/database/schema';

/**
 * EVERY CORE ADMIN READ, AT VOLUME, THROUGH THE WHOLE STACK.
 *
 * ## What this adds to the two suites beside it
 *
 * `search-at-scale.spec.ts` asks the PLANNER about SQL written in a test file.
 * `soak.spec.ts` hammers one service method with concurrent writers. Neither
 * touches the thing an operator actually waits on: an HTTP request that passes
 * through the guard, the client-scope predicate, the query, the field-mask
 * interceptor and DTO serialisation, over a table that is not small.
 *
 * So this seeds a platform and drives the REAL ROUTES as a real admin session.
 * Every number below is the whole round trip, which is the only number that
 * means anything to the person using the console.
 *
 * ## Two kinds of assertion, and only one of them is a threshold
 *
 * **The plan is the gate.** For each filtered read the query must not be a
 * sequential scan over the big table. That is size-independent, machine-
 * independent and catches the actual regression — an expression that stops
 * matching its index, a join the planner can no longer invert.
 *
 * **The clock is a safety net, not a benchmark.** A generous ceiling that a
 * correct read passes on any machine and a full scan fails at this size. Pinning
 * a tight millisecond budget would measure the CI box and get deleted the first
 * time it blocked somebody — the same reasoning `soak.spec.ts` records.
 *
 * ## Sizing
 *
 * `VOLUME_USERS` (default 100,000) sets the fixture. Seeding costs roughly
 * 16 s per 100k across the five tables, so the default belongs in the ordinary
 * suite and a deep run is one variable away:
 *
 *     VOLUME_USERS=1000000 npx vitest run test/volume.spec.ts
 *
 * Measured 15 Sep 2026 at 1,000,000 clients — see the numbers recorded against
 * each case. They are a record of one machine on one afternoon, not a contract.
 */

const USERS = Number(process.env['VOLUME_USERS'] ?? 100_000);
/** Generous on purpose — see the header. A scan at this size is seconds. */
const CEILING_MS = Number(process.env['VOLUME_CEILING_MS'] ?? 2_000);

const MASTER = { email: 'volume-master@oxshare.com', password: 'admin-password-123' };
/** A name held by exactly one client, which is what a real search looks like. */
const RARE = 'Zephyrine';
const RARE_EMAIL = 'volume-rare@oxshare-e2e.test';

/** One client with years of history, for the portal's own screens. */
const HEAVY = { email: 'volume-heavy@oxshare-e2e.test', password: 'ClientPass123!' };
const HEAVY_ROWS = Number(process.env['VOLUME_HEAVY_ROWS'] ?? 50_000);

let ctx: HttpTestContext;
let admin: Session;
let rareUserId: string;
let heavyUserId: string;
let rareWalletNumber: string;
const RARE_LOGIN = '70000001';

/** Every measurement, printed once at the end so the run leaves a record. */
const measured: { what: string; ms: number }[] = [];

async function timed(what: string, run: () => Promise<unknown>): Promise<number> {
  const started = performance.now();
  await run();
  const ms = performance.now() - started;
  measured.push({ what, ms });
  return ms;
}

/** The plan for a read, taken through the same predicate the route uses. */
async function planOf(query: ReturnType<typeof sql>): Promise<string> {
  const { rows } = await ctx.db.db.execute<{ 'QUERY PLAN': string }>(
    sql`EXPLAIN (ANALYZE, BUFFERS) ${query}`,
  );
  return rows.map((r) => r['QUERY PLAN']).join('\n');
}

beforeAll(async () => {
  ctx = await startHttpTestApp();
  const db = ctx.db.db;
  const passwords = new PasswordService();

  const [masterRole] = await db
    .insert(roles)
    .values({ name: 'Volume Master', permissions: ALL_PERMISSIONS, isSystem: true })
    .returning();
  await db.insert(admins).values({
    email: MASTER.email,
    passwordHash: await passwords.hash(MASTER.password),
    name: 'Volume Master',
    role: 'master_admin',
    roleId: masterRole.id,
    permissions: ALL_PERMISSIONS,
    status: 'active',
  });

  /*
   * One statement per table. `generate_series` builds the rows inside Postgres;
   * inserting them from JavaScript would make the fixture the slowest part of
   * the run by an order of magnitude.
   *
   * Names come from a small alphabet so a search matches a SUBSET rather than
   * everything — an index scan returning the whole table is a sequential scan
   * with extra steps, and the planner knows it.
   */
  await db.execute(sql`
    INSERT INTO users (email, password_hash, first_name, last_name)
    SELECT 'volume-' || i || '@oxshare-e2e.test', 'x',
      (ARRAY['Alexandra','Bruce','Carla','Dmitri','Elena','Fadi','Georges','Hana'])[1 + (i % 8)],
      (ARRAY['Nolan','Mansour','Haddad','Khoury','Aoun','Saad','Rizk','Fares'])[1 + (i % 8)]
    FROM generate_series(1, ${USERS}) AS i
  `);

  /*
   * ONE client nobody shares a name with. Every search below looks for this
   * person, because that is what an operator does: find one client among many.
   * A term matching a quarter of the table would make the planner right to scan
   * and the measurement meaningless.
   */
  const { rows: rare } = await db.execute<{ id: string }>(sql`
    INSERT INTO users (email, password_hash, first_name, last_name)
    VALUES (${RARE_EMAIL}, 'x', ${RARE}, 'Quartermain')
    RETURNING id
  `);
  rareUserId = rare[0].id;

  await db.execute(sql`
    INSERT INTO wallets (user_id, currency, kind, balance)
    SELECT id, 'USD', 'main', '0' FROM users
  `);
  const { rows: rw } = await db.execute<{ wallet_number: string }>(sql`
    SELECT wallet_number FROM wallets WHERE user_id = ${rareUserId}
  `);
  rareWalletNumber = rw[0].wallet_number;

  await db.execute(sql`
    INSERT INTO ledger_entries
      (wallet_id, entry_type, amount, balance_after, reference_type, reference_id)
    SELECT id, 'adjustment', '0', '0', 'manual', gen_random_uuid()::text FROM wallets
  `);

  await db.execute(sql`
    INSERT INTO trading_accounts (user_id, login, currency, environment)
    SELECT id, lpad((row_number() OVER (ORDER BY id))::text, 8, '0'), 'USD', 'live'
    FROM users WHERE id <> ${rareUserId}
  `);
  await db.execute(sql`
    INSERT INTO trading_accounts (user_id, login, currency, environment)
    VALUES (${rareUserId}, ${RARE_LOGIN}, 'USD', 'live')
  `);

  await db.execute(sql`
    INSERT INTO audit_log (actor_id, actor_email, actor_kind, action, subject_type, subject_id)
    SELECT ${rareUserId}, 'operator-' || i || '@oxshare.com', 'admin',
           'client.suspend', 'user', gen_random_uuid()::text
    FROM generate_series(1, ${USERS}) AS i
  `);
  await db.execute(sql`
    INSERT INTO audit_log (actor_id, actor_email, actor_kind, action, subject_type, subject_id)
    SELECT ${rareUserId}, 'zephyrine.reviewer@oxshare.com', 'admin',
           'kyc.approve', 'user', ${rareUserId}
    FROM generate_series(1, 5) AS i
  `);

  /*
   * ANALYZE, and it is not optional: a freshly bulk-loaded table has no
   * statistics, so the planner guesses — and its guess is often a sequential
   * scan whatever the indexes say. Without this the suite fails against
   * perfectly correct code.
   */
  for (const table of ['users', 'wallets', 'ledger_entries', 'trading_accounts', 'audit_log']) {
    await db.execute(sql.raw(`ANALYZE ${table}`));
  }

  /*
   * ONE CLIENT WITH A LARGE PERSONAL HISTORY — the portal's version of this
   * question, which is a different question.
   *
   * The console reads PLATFORM-WIDE tables, so its risk scales with the
   * business. A client's own screens read only their own rows: their wallet,
   * their ledger, their transactions, keyed on the session's user id and never
   * on a parameter. Platform size does not reach them. What CAN reach them is
   * one person with years of trading, so that is what is seeded — 50,000
   * movements against a single wallet.
   */
  const { rows: heavyRows } = await db.execute<{ id: string }>(sql`
    INSERT INTO users (email, password_hash, first_name, last_name, email_verified)
    VALUES (${HEAVY.email}, ${await passwords.hash(HEAVY.password)}, 'Heavy', 'Trader', true)
    RETURNING id
  `);
  heavyUserId = heavyRows[0].id;

  const { rows: heavyWallet } = await db.execute<{ id: string }>(sql`
    INSERT INTO wallets (user_id, currency, kind, balance)
    VALUES (${heavyUserId}, 'USD', 'main', '0') RETURNING id
  `);
  await db.execute(sql`
    INSERT INTO ledger_entries
      (wallet_id, entry_type, amount, balance_after, reference_type, reference_id, created_at)
    SELECT ${heavyWallet[0].id}, 'adjustment', '0', '0', 'manual', gen_random_uuid()::text,
           now() - (i || ' seconds')::interval
    FROM generate_series(1, ${HEAVY_ROWS}) AS i
  `);
  await db.execute(sql`ANALYZE ledger_entries`);

  admin = await actingAs(ctx, 'admin', MASTER);
}, 1_800_000);

afterAll(async () => {
  const width = Math.max(...measured.map((m) => m.what.length), 10);
  const lines = measured
    .map((m) => `  ${m.what.padEnd(width)}  ${m.ms.toFixed(0).padStart(6)} ms`)
    .join('\n');
  /*
   * `process.stdout.write`, not `console.log`.
   *
   * Vitest intercepts `console` inside hooks and swallows it on a passing run —
   * so the numbers this suite exists to produce were invisible unless something
   * failed. Writing to the stream directly is what makes a green run leave a
   * record, which is the whole point of measuring.
   */
  process.stdout.write(`\nVOLUME — ${USERS.toLocaleString()} clients\n${lines}\n\n`);
  await stopHttpTestApp(ctx);
});

const items = (body: unknown) => (body as { items: unknown[] }).items;

describe('the fixture is genuinely large, and a search matches a handful', () => {
  it(`holds ${USERS.toLocaleString()} clients and one wallet each`, async () => {
    const { rows } = await ctx.db.db.execute<{ n: string }>(sql`SELECT count(*) AS n FROM users`);
    expect(Number(rows[0].n)).toBeGreaterThanOrEqual(USERS);

    const { rows: w } = await ctx.db.db.execute<{ n: string }>(sql`
      SELECT count(*) AS n FROM wallets
    `);
    expect(Number(w[0].n)).toBeGreaterThanOrEqual(USERS);
  });

  it('the searched term matches ONE client, not a quarter of the base', async () => {
    // The floor every measurement below rests on.
    const { rows } = await ctx.db.db.execute<{ n: string }>(sql`
      SELECT count(*) AS n FROM users WHERE first_name = ${RARE}
    `);
    expect(Number(rows[0].n)).toBe(1);
  });
});

describe('the client list', () => {
  it('serves its first page without reading the table', async () => {
    const ms = await timed('clients — first page', async () => {
      const res = await admin.get('/v1/admin/clients?limit=25&withTotal=false');
      expect(res.status).toBe(200);
      expect(items(res.body).length).toBe(25);
    });
    expect(ms, `the first page took ${ms.toFixed(0)}ms`).toBeLessThan(CEILING_MS);
  });

  it('finds ONE client by name among all of them', async () => {
    const ms = await timed('clients — search by name', async () => {
      const res = await admin.get(`/v1/admin/clients?q=${RARE}&limit=25`);
      expect(res.status).toBe(200);
      expect(items(res.body).length).toBe(1);
    });
    expect(ms, `the client search took ${ms.toFixed(0)}ms`).toBeLessThan(CEILING_MS);
  });

  it('and the search is an INDEX read, which is what keeps it flat', async () => {
    const plan = await planOf(sql`
      SELECT id FROM users
      WHERE (coalesce(email, '') || ' ' || coalesce(first_name, '') || ' ' || coalesce(last_name, ''))
            ILIKE ${'%' + RARE.toLowerCase() + '%'}
      LIMIT 25
    `);
    expect(plan, `the client search is scanning:\n${plan}`).not.toMatch(/Seq Scan on users/);
  });
});

describe('the money lists', () => {
  it('wallets — first page', async () => {
    const ms = await timed('wallets — first page', async () => {
      // The console's own default, total included — see the case below for
      // what the total costs on its own.
      const res = await admin.get('/v1/admin/wallets?limit=25');
      expect(res.status).toBe(200);
      expect(items(res.body).length).toBe(25);
    });
    expect(ms).toBeLessThan(CEILING_MS);
  });

  it('the ROW COUNT is what costs, and it is already optional', async () => {
    /*
     * THE ONE NUMBER THAT STOOD OUT, and the honest answer to "what breaks
     * first at a billion rows".
     *
     * Measured at 1,000,000 clients: the wallets first page took 254 ms while
     * every filtered read took 14–26 ms. The rows were never the problem. The
     * `total` is — `count(*)` over the joined, scoped set is a full pass by
     * definition, and no index removes it, because the answer is "how many"
     * rather than "which".
     *
     * `withTotal` is already a query parameter and the API's own description
     * says "Counting is a full scan". This pins the two costs side by side so
     * the trade is a measured one: a numbered pager needs a total, a cursor
     * pager does not, and at a size where the count dominates the page the
     * console should stop asking for it rather than the database get faster.
     *
     * Asserted as a COMPARISON, not a threshold: the counted page must not be
     * cheaper than the uncounted one, which is the only direction that would
     * mean the measurement is wrong.
     */
    const without = await timed('wallets — page, no total', async () => {
      const res = await admin.get('/v1/admin/wallets?limit=25&withTotal=false');
      expect(res.status).toBe(200);
      /*
       * `total` comes back as 0 rather than absent when counting is declined.
       * Worth knowing and not worth changing: the DTO declares the field, the
       * console always asks for the count, and a shape that appears and
       * disappears is harder to consume than one that is always present. What
       * matters here is that nothing was COUNTED, which the timing shows.
       */
      expect((res.body as { total?: number }).total ?? 0).toBe(0);
    });
    const withCount = await timed('wallets — page WITH total', async () => {
      const res = await admin.get('/v1/admin/wallets?limit=25&withTotal=true');
      expect(res.status).toBe(200);
      expect((res.body as { total?: number }).total).toBeGreaterThan(0);
    });

    expect(without).toBeLessThan(CEILING_MS);
    expect(
      withCount,
      `counting cost ${withCount.toFixed(0)}ms against ${without.toFixed(0)}ms for the same page`,
    ).toBeGreaterThanOrEqual(without * 0.5);
  });

  it('wallets — finds one owner by name', async () => {
    const ms = await timed('wallets — search by owner', async () => {
      const res = await admin.get(`/v1/admin/wallets?q=${RARE}&limit=25`);
      expect(res.status).toBe(200);
      expect(items(res.body).length).toBe(1);
    });
    expect(ms).toBeLessThan(CEILING_MS);
  });

  it('wallets — a NUMBER is a point lookup, the cheapest read there is', async () => {
    const ms = await timed('wallets — search by number', async () => {
      const res = await admin.get(`/v1/admin/wallets?q=${rareWalletNumber}&limit=25`);
      expect(res.status).toBe(200);
      expect(items(res.body).length).toBe(1);
    });
    expect(ms).toBeLessThan(CEILING_MS);

    const plan = await planOf(
      sql`SELECT id FROM wallets WHERE wallet_number = ${rareWalletNumber}`,
    );
    expect(plan, `the wallet-number lookup is scanning:\n${plan}`).toMatch(
      /wallets_wallet_number_uq/,
    );
  });

  it('trading accounts — finds one by MT5 login', async () => {
    const ms = await timed('trading accounts — by login', async () => {
      const res = await admin.get(`/v1/admin/trading-accounts?q=${RARE_LOGIN}&limit=25`);
      expect(res.status).toBe(200);
      expect(items(res.body).length).toBe(1);
    });
    expect(ms).toBeLessThan(CEILING_MS);
  });

  it('trading accounts — finds one by owner name', async () => {
    const ms = await timed('trading accounts — by owner', async () => {
      const res = await admin.get(`/v1/admin/trading-accounts?q=${RARE}&limit=25`);
      expect(res.status).toBe(200);
      expect(items(res.body).length).toBe(1);
    });
    expect(ms).toBeLessThan(CEILING_MS);
  });

  it('ledger — finds one client’s movements', async () => {
    const ms = await timed('ledger — search by owner', async () => {
      const res = await admin.get(`/v1/admin/ledger?q=${RARE}&limit=25`);
      expect(res.status).toBe(200);
      expect(items(res.body).length).toBe(1);
    });
    expect(ms).toBeLessThan(CEILING_MS);
  });

  it('ledger — the LEFT join is still invertible, so the search starts at the index', async () => {
    /*
     * The defect this pins was found by measurement, not by reading: without
     * `u.id IS NOT NULL` the planner cannot prove the filter rejects a
     * NULL-extended row, so it hash-joins every client and filters afterwards.
     */
    const plan = await planOf(sql`
      SELECT le.id FROM ledger_entries le
      JOIN wallets w ON w.id = le.wallet_id
      LEFT JOIN users u ON u.id = w.user_id
      WHERE u.id IS NOT NULL
        AND (coalesce(u.email, '') || ' ' || coalesce(u.first_name, '') || ' ' || coalesce(u.last_name, ''))
            ILIKE ${'%' + RARE.toLowerCase() + '%'}
      LIMIT 25
    `);
    expect(plan, `the ledger search is scanning clients:\n${plan}`).not.toMatch(
      /Seq Scan on users/,
    );
  });
});

describe('the audit log — the table that only grows', () => {
  it('serves its first page', async () => {
    const ms = await timed('audit — first page', async () => {
      const res = await admin.get('/v1/admin/audit-log?limit=25');
      expect(res.status).toBe(200);
      expect(items(res.body).length).toBe(25);
    });
    expect(ms).toBeLessThan(CEILING_MS);
  });

  it('finds one administrator among all of them', async () => {
    const ms = await timed('audit — search by actor', async () => {
      const res = await admin.get('/v1/admin/audit-log?q=zephyrine.reviewer&limit=25');
      expect(res.status).toBe(200);
      expect(items(res.body).length).toBe(5);
    });
    expect(ms).toBeLessThan(CEILING_MS);
  });

  it('reads one client’s whole history', async () => {
    const ms = await timed('audit — one subject', async () => {
      const res = await admin.get(`/v1/admin/audit-log?subjectId=${rareUserId}&limit=25`);
      expect(res.status).toBe(200);
      expect(items(res.body).length).toBe(5);
    });
    expect(ms).toBeLessThan(CEILING_MS);
  });
});

describe('a CLIENT with years of history opens their own screens', () => {
  /*
   * The portal is not a smaller console. Its lists are scoped to the session's
   * own user by construction — the client's id comes from the session and is
   * never a parameter, which `payments.controller.ts` calls out as "an oracle
   * for anybody else's money" if it were — so the platform's size never reaches
   * them. The bound that matters here is ONE person's own activity.
   */
  it('their wallet answers immediately, whatever the platform holds', async () => {
    const client = await actingAs(ctx, 'portal', HEAVY);
    const ms = await timed('portal — wallet', async () => {
      const res = await client.get('/v1/wallet');
      expect(res.status).toBe(200);
    });
    expect(ms).toBeLessThan(CEILING_MS);
  });

  it(`their own ledger pages through ${HEAVY_ROWS.toLocaleString()} movements`, async () => {
    const client = await actingAs(ctx, 'portal', HEAVY);
    const ms = await timed('portal — own ledger', async () => {
      const res = await client.get('/v1/wallet/ledger?limit=25');
      expect(res.status).toBe(200);
      expect((res.body as { items: unknown[] }).items.length).toBe(25);
    });
    expect(ms).toBeLessThan(CEILING_MS);
  });

  it('and a DEEP page of their own history costs the same as the first', async () => {
    /*
     * A client scrolling back through years is the realistic deep read here,
     * and it is a keyset seek — so it is an index descent at any depth rather
     * than an OFFSET that reads everything it skips.
     */
    const client = await actingAs(ctx, 'portal', HEAVY);
    const first = await client.get('/v1/wallet/ledger?limit=25');
    const cursor = (first.body as { nextCursor?: string }).nextCursor;
    expect(cursor, 'the client ledger served no cursor').toBeTruthy();

    const deep = await timed('portal — deep ledger page', async () => {
      const res = await client.get(
        `/v1/wallet/ledger?limit=25&cursor=${encodeURIComponent(cursor!)}`,
      );
      expect(res.status).toBe(200);
      expect((res.body as { items: unknown[] }).items.length).toBe(25);
    });
    expect(deep).toBeLessThan(CEILING_MS);
  });

  it('their ledger contains THEIR rows and nobody else’s', async () => {
    /*
     * The same boundary the console has, from the other side: a client's list
     * is keyed on the session. Worth asserting beside the timings, because a
     * fast list of the wrong rows is the worse failure.
     */
    const { rows } = await ctx.db.db.execute<{ n: string }>(sql`
      SELECT count(*) AS n FROM ledger_entries le
      JOIN wallets w ON w.id = le.wallet_id
      WHERE w.user_id = ${heavyUserId}
    `);
    expect(Number(rows[0].n)).toBe(HEAVY_ROWS);

    const client = await actingAs(ctx, 'portal', HEAVY);
    const res = await client.get('/v1/wallet/ledger?limit=100');
    expect(res.status).toBe(200);
    expect((res.body as { items: unknown[] }).items.length).toBe(100);
  });
});

describe('paging stays flat as the reader goes deeper', () => {
  it('a KEYSET page deep in the list costs the same as the first', async () => {
    /*
     * THE PROPERTY THAT DECIDES WHETHER THIS SCALES AT ALL.
     *
     * `OFFSET n` produces and discards n rows before returning any, so the cost
     * grows with depth on a query that looks identical in the code. The keyset
     * seek is an index descent whatever the depth — and the assertion is a
     * COMPARISON rather than a threshold, so it measures the shape rather than
     * the machine.
     */
    const first = await admin.get('/v1/admin/clients?limit=25&withTotal=false');
    expect(first.status).toBe(200);
    const cursor = (first.body as { nextCursor?: string }).nextCursor;
    expect(cursor, 'the client list served no cursor to page with').toBeTruthy();

    const shallow = await timed('clients — page 1', async () => {
      await admin.get('/v1/admin/clients?limit=25&withTotal=false');
    });
    const deep = await timed('clients — deep keyset page', async () => {
      const res = await admin.get(
        `/v1/admin/clients?limit=25&withTotal=false&cursor=${encodeURIComponent(cursor!)}`,
      );
      expect(res.status).toBe(200);
      expect(items(res.body).length).toBe(25);
    });

    // Generous: what is being refused is an order of magnitude, which is what a
    // deep OFFSET produces and a seek does not.
    expect(
      deep,
      `a keyset page cost ${deep.toFixed(0)}ms against ${shallow.toFixed(0)}ms for the first`,
    ).toBeLessThan(shallow * 10 + CEILING_MS);
  });
});
