import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { WalletService } from '../src/modules/wallet/wallet.service';
import { startMoneyTestDb, stopMoneyTestDb, type MoneyTestContext } from './money-setup';

/**
 * SUSTAINED LOAD, AND WHAT IT IS ACTUALLY ALLOWED TO CLAIM.
 *
 * ## Why this exists
 *
 * Every domain sign-off in `docs/SLICES.md` closed with the same sentence:
 * "swept, not soaked — nothing ran for hours and nothing here says the product
 * survives sustained load". `search-at-scale.spec.ts` then measured the SHAPE of
 * the queries at volume, which is the §5 risk. This measures the other half: what
 * happens when many callers move money at the same time, for a while, with the
 * background engines running underneath them.
 *
 * ## What it asserts, and why these and not latency
 *
 * A soak that asserts a millisecond budget is a flake generator: it fails on a
 * loaded CI box and passes on a fast laptop, and the first time it blocks
 * somebody it gets deleted. So the hard assertions here are all CORRECTNESS
 * under contention — facts that are either true or the system has lost money:
 *
 *   · the balance after N concurrent writes is exactly the arithmetic
 *   · every `balance_after` in the ledger is a real running total, so no write
 *     read a stale balance and wrote a plausible wrong number
 *   · an idempotency key fired 50 times at once produces exactly ONE entry
 *   · concurrent withdrawals that cannot all fit refuse the right number of
 *     them, and the balance never goes negative
 *   · nothing deadlocks, and the pool saturates without erroring
 *
 * The only TIMING claim is a stability one, with a deliberately loose bound: the
 * slowest quarter must not be an order of magnitude worse than the first. That
 * catches a leak, a lock held across a loop, an unbounded queue — the things
 * that get worse with time — while tolerating the jitter of a shared machine.
 *
 * ## The durations are configurable, and the default is CI-sized
 *
 * `SOAK_SECONDS=300 npm test -- soak` for a real endurance run. The default is
 * short enough to belong in the ordinary suite, because a soak that only ever
 * runs when somebody remembers to run it is not a gate.
 *
 * ## What this still does NOT claim
 *
 * It is one process against one database. It says nothing about multiple API
 * instances, about the realtime engine under fan-out, or about hours rather than
 * seconds. `docs/SLICES.md` should keep saying so.
 */

const SOAK_SECONDS = Number(process.env['SOAK_SECONDS'] ?? 15);
const WORKERS = Number(process.env['SOAK_WORKERS'] ?? 24);
/** Deliberately more than the pool (10): saturation is part of the test. */
const CONTENTION = Number(process.env['SOAK_CONTENTION'] ?? 200);
const WALLET_COUNT = Number(process.env['SOAK_WALLETS'] ?? 12);

let ctx: MoneyTestContext;
let wallets: WalletService;
let hotUserId: string;
const spread: string[] = [];

async function makeUser(email: string): Promise<string> {
  const { rows } = await ctx.db.execute<{ id: string }>(sql`
    INSERT INTO users (email, password_hash, first_name, last_name)
    VALUES (${email}, 'x', 'Soak', 'Person') RETURNING id
  `);
  return rows[0].id;
}

async function balanceOf(userId: string): Promise<string> {
  const { rows } = await ctx.db.execute<{ balance: string }>(sql`
    SELECT balance FROM wallets WHERE user_id = ${userId} AND currency = 'USD' AND kind = 'main'
  `);
  return rows[0].balance;
}

/** Percentile from an unsorted sample, for the stability check only. */
function percentile(values: number[], p: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))] ?? 0;
}

beforeAll(async () => {
  ctx = await startMoneyTestDb();
  wallets = new WalletService(ctx.db);

  hotUserId = await makeUser('soak-hot@oxshare-e2e.test');
  await wallets.getOrCreateWallet(hotUserId, 'USD');

  for (let i = 0; i < WALLET_COUNT; i++) {
    const id = await makeUser(`soak-spread-${i}@oxshare-e2e.test`);
    await wallets.getOrCreateWallet(id, 'USD');
    spread.push(id);
  }
}, 300_000);

afterAll(async () => {
  await stopMoneyTestDb(ctx);
});

describe('one wallet, many writers', () => {
  it(`survives ${CONTENTION} concurrent credits with the arithmetic exactly right`, async () => {
    /*
     * §6.2 calls the lost update "the single most likely money bug in the
     * system". `wallet-service.spec.ts` already fires ten of these; this fires
     * two hundred, which is twenty times the connection pool, so most of them
     * are queued behind both the pool AND the row lock rather than merely
     * interleaved. That is the state a busy afternoon actually produces.
     */
    const posts = Array.from({ length: CONTENTION }, (_, i) =>
      wallets.post({
        userId: hotUserId,
        currency: 'USD',
        amount: '10',
        entryType: 'deposit',
        referenceType: 'transaction',
        referenceId: `soak-credit-${i}`,
      }),
    );
    const settled = await Promise.allSettled(posts);

    const failures = settled.filter((r) => r.status === 'rejected');
    expect(
      failures.map((f) => String((f as { reason: unknown }).reason)),
      'a concurrent credit failed — a deadlock or an exhausted pool',
    ).toEqual([]);

    expect(await balanceOf(hotUserId)).toBe(`${CONTENTION * 10}.00000000`);
  }, 300_000);

  it('every balance_after is a real running total, not a plausible wrong number', async () => {
    /*
     * THE ASSERTION THAT CATCHES A LOST UPDATE THE TOTAL WOULD HIDE.
     *
     * A final balance can be right while the ledger is wrong: two writers that
     * both read the same prior balance write the same `balance_after`, and a
     * third correction can still land the total on the expected number. So the
     * SET of running totals is checked instead — with equal credits of 10 the
     * only correct multiset is {10, 20, … CONTENTION×10}, in whatever order the
     * locks produced. A duplicate or a gap in that set IS the lost update, and
     * it is visible here whatever the total says.
     */
    const { rows } = await ctx.db.execute<{ balance_after: string }>(sql`
      SELECT le.balance_after
      FROM ledger_entries le
      JOIN wallets w ON w.id = le.wallet_id
      WHERE w.user_id = ${hotUserId}
    `);
    expect(rows.length).toBe(CONTENTION);

    const seen = rows.map((r) => Number(r.balance_after)).sort((a, b) => a - b);
    const expected = Array.from({ length: CONTENTION }, (_, i) => (i + 1) * 10);
    expect(seen).toEqual(expected);
  });

  it('an idempotency key fired fifty times at once lands exactly once', async () => {
    /*
     * §6.3: idempotency lives in DATABASE CONSTRAINTS, never in "check then
     * insert". Under contention that distinction is the whole thing — fifty
     * check-then-inserts racing each other all see no row and all insert.
     *
     * A double-clicked button and a retried webhook are the ordinary causes, and
     * both arrive concurrently by nature.
     */
    const before = await balanceOf(hotUserId);
    const settled = await Promise.allSettled(
      Array.from({ length: 50 }, () =>
        wallets.post({
          userId: hotUserId,
          currency: 'USD',
          amount: '7.25',
          entryType: 'deposit',
          referenceType: 'transaction',
          referenceId: 'soak-one-and-only',
        }),
      ),
    );
    // Some callers see a conflict and some see the replay absorbed; what must
    // never happen is fifty credits. The count is the assertion, not the shape
    // of the rejections.
    expect(settled.length).toBe(50);

    const { rows } = await ctx.db.execute<{ n: string }>(sql`
      SELECT count(*) AS n
      FROM ledger_entries le
      JOIN wallets w ON w.id = le.wallet_id
      WHERE w.user_id = ${hotUserId} AND le.reference_id = 'soak-one-and-only'
    `);
    expect(Number(rows[0].n), 'the idempotency key was not honoured under contention').toBe(1);
    expect(Number(await balanceOf(hotUserId))).toBeCloseTo(Number(before) + 7.25, 8);
  }, 120_000);
});

describe('the balance cannot go negative, however many callers try at once', () => {
  it('refuses exactly the withdrawals that do not fit', async () => {
    /*
     * The most valuable thing a money soak can say.
     *
     * A wallet holding 100 and twenty concurrent withdrawals of 25: exactly four
     * must succeed and sixteen must be refused. `post` takes `FOR UPDATE` and
     * refuses an overdraft inside the same transaction, so the refusal IS the
     * balance check and cannot be raced — a check before the insert is a
     * read-then-write, and all twenty would pass it.
     *
     * The failure this catches is silent and expensive: a client withdrawing
     * more than they hold, discovered at reconciliation months later.
     *
     * ⚠️ This case passes whichever layer refuses — see the one below, which
     * names the layer. It is the INVARIANT that is pinned here.
     */
    const userId = await makeUser('soak-overdraft@oxshare-e2e.test');
    await wallets.getOrCreateWallet(userId, 'USD');
    await wallets.post({
      userId,
      currency: 'USD',
      amount: '100',
      entryType: 'deposit',
      referenceType: 'transaction',
      referenceId: 'soak-overdraft-funding',
    });

    const settled = await Promise.allSettled(
      Array.from({ length: 20 }, (_, i) =>
        wallets.post({
          userId,
          currency: 'USD',
          amount: '-25',
          entryType: 'withdrawal',
          referenceType: 'transaction',
          referenceId: `soak-overdraft-${i}`,
        }),
      ),
    );

    const ok = settled.filter((r) => r.status === 'fulfilled').length;
    expect(ok, 'more withdrawals succeeded than the wallet could pay for').toBe(4);
    expect(await balanceOf(userId)).toBe('0.00000000');

    const { rows } = await ctx.db.execute<{ n: string }>(sql`
      SELECT count(*) AS n FROM wallets WHERE balance < 0
    `);
    expect(Number(rows[0].n), 'a wallet went negative').toBe(0);
  }, 120_000);

  it('the DATABASE refuses a negative balance, not only the service', async () => {
    /*
     * WHICH LAYER IS ACTUALLY HOLDING THIS LINE — found by mutating, not by
     * reading.
     *
     * Deleting the service's overdraft check left the case above GREEN: still
     * exactly four withdrawals, still a zero balance. The refusal was coming
     * from the DATABASE all along — and from two constraints rather than one:
     * `wallets_balance_non_negative` (0030) and `wallets_hold_within_balance`,
     * which also fails when a zero hold no longer fits inside a negative
     * balance. Dropping either alone leaves this case green; dropping both lets
     * the UPDATE through, which is how that was established rather than assumed.
     *
     * All three layers are wanted — the service produces a sentence a person can
     * act on, the constraints are the guarantee — but a test that cannot tell
     * them apart would report the guarantee as present while only the message
     * survived.
     *
     * It is pinned by ATTEMPTING the forbidden thing, for the reason the
     * append-only ledger records: a test that never tries the prohibited act
     * does not test the prohibition. And this exact class of loss has happened
     * here — 0028 dropped `ledger_entries`, taking its triggers with it, and
     * nothing noticed for a month; 0082 removed the matching constraint from
     * `trading_accounts` deliberately. A table rebuild that quietly left this
     * one behind would be invisible from the application side, because the
     * service check would keep the ordinary path looking correct.
     */
    const userId = await makeUser('soak-constraint@oxshare-e2e.test');
    await wallets.getOrCreateWallet(userId, 'USD');

    await expect(
      ctx.db.execute(sql`
        UPDATE wallets SET balance = '-0.00000001'
        WHERE user_id = ${userId} AND currency = 'USD'
      `),
      'the database accepted a negative wallet balance',
    ).rejects.toThrow();
  });
});

describe(`sustained mixed load for ${SOAK_SECONDS}s`, () => {
  const latencies: number[] = [];
  let operations = 0;
  const errors: string[] = [];

  it('runs without a single failed operation', async () => {
    /*
     * Many writers over many wallets, for a while. Spreading across wallets is
     * what makes this different from the contention case above: each worker
     * picks a wallet at random, so lock ordering varies run to run and a
     * deadlock — two transactions grabbing the same two rows in opposite orders
     * — has the chance to appear that a single-row test never gives it.
     */
    const deadline = Date.now() + SOAK_SECONDS * 1_000;
    let sequence = 0;

    const worker = async (worker: number) => {
      while (Date.now() < deadline) {
        const target = spread[(worker + sequence) % spread.length];
        const id = sequence++;
        const started = performance.now();
        try {
          await wallets.post({
            userId: target,
            currency: 'USD',
            amount: id % 3 === 0 ? '-1' : '5',
            entryType: id % 3 === 0 ? 'withdrawal' : 'deposit',
            referenceType: 'transaction',
            referenceId: `soak-load-${worker}-${id}`,
          });
          operations++;
          latencies.push(performance.now() - started);
        } catch (error) {
          // A refused overdraft is a correct answer, not a failure: the '-1'
          // legs can outrun the credits on a wallet early in the run.
          const message = String(error);
          if (!/insufficient|balance|overdraft/i.test(message)) errors.push(message);
        }
      }
    };

    await Promise.all(Array.from({ length: WORKERS }, (_, i) => worker(i)));

    expect(errors.slice(0, 5), 'operations failed under sustained load').toEqual([]);
    /*
     * THE FLOOR, and it is set from a measurement rather than from optimism.
     *
     * Measured 15 Sep 2026 (WSL2, shared Postgres container, pool of 10, 24
     * workers, 15 s): **17,846 completed money writes**, ~1,190 per second,
     * every one of them through the real `post` path with `SELECT … FOR UPDATE`
     * and a ledger insert. The floor is an order of magnitude under that, so it
     * fails on a run that collapsed and tolerates a slow machine — a threshold
     * pinned just under a measured number is one that goes red the first time
     * CI has a bad afternoon, and then gets deleted.
     *
     * Without a floor the stability check below is vacuous: four samples have
     * percentiles too.
     */
    expect(operations, 'the load generator did almost no work').toBeGreaterThan(2_000);
  }, 600_000);

  it('leaves a record of what it actually did', () => {
    /*
     * `process.stdout.write`, not `console.log`: vitest intercepts `console`
     * inside tests and hooks and swallows it on a passing run, so the numbers a
     * soak exists to produce were invisible unless something failed. A green
     * endurance run that reports nothing is indistinguishable from one that did
     * nothing.
     */
    const p50 = percentile(latencies, 0.5);
    const p95 = percentile(latencies, 0.95);
    const p99 = percentile(latencies, 0.99);
    const perSecond = operations / SOAK_SECONDS;
    process.stdout.write(
      `\nSOAK — ${SOAK_SECONDS}s, ${WORKERS} workers\n` +
        `  money writes            ${operations.toLocaleString().padStart(9)}\n` +
        `  per second              ${perSecond.toFixed(0).padStart(9)}\n` +
        `  p50 / p95 / p99         ${p50.toFixed(1)} / ${p95.toFixed(1)} / ${p99.toFixed(1)} ms\n` +
        `  failures                ${String(errors.length).padStart(9)}\n\n`,
    );
    expect(operations).toBeGreaterThan(0);
  });

  it('does not get slower as it goes — no leak, no lock held across a loop', () => {
    /*
     * The ONLY timing claim in this file, and the bound is deliberately loose.
     *
     * What is being looked for is a TREND: a connection never returned, a
     * transaction held open across an await, an index degrading as the table
     * grows. Those make the last quarter catastrophically worse, not marginally.
     * A tight bound here would instead measure the machine, fail on a loaded CI
     * box, and be deleted the first time it blocked somebody — which is how a
     * performance gate becomes no gate.
     */
    const quarter = Math.floor(latencies.length / 4);
    expect(quarter, 'not enough samples to judge stability').toBeGreaterThan(10);

    const first = percentile(latencies.slice(0, quarter), 0.95);
    const last = percentile(latencies.slice(-quarter), 0.95);

    expect(
      last,
      `p95 degraded from ${first.toFixed(1)}ms to ${last.toFixed(1)}ms over ${operations} operations`,
    ).toBeLessThan(first * 10 + 50);
  });
});

describe('after all of it, the books still balance', () => {
  it('every wallet equals the sum of its own ledger, to the cent', async () => {
    /*
     * §11's reconciliation, run over a database that has just taken thousands of
     * concurrent writes rather than over a fixture. This is the acceptance
     * condition §14 states, asked at the one moment it is hardest to satisfy.
     */
    const { rows } = await ctx.db.execute<{
      wallet_id: string;
      balance: string;
      ledger_sum: string;
    }>(sql`
      SELECT w.id AS wallet_id,
             w.balance,
             coalesce(sum(le.amount), 0)::text AS ledger_sum
      FROM wallets w
      LEFT JOIN ledger_entries le ON le.wallet_id = w.id
      GROUP BY w.id, w.balance
      HAVING w.balance <> coalesce(sum(le.amount), 0)
    `);
    expect(rows, `wallets disagree with their ledgers:\n${JSON.stringify(rows)}`).toEqual([]);
  });

  it('checked a real number of wallets, not zero', async () => {
    // The non-vacuity floor: a reconciliation over nothing balances.
    const { rows } = await ctx.db.execute<{ n: string }>(sql`
      SELECT count(*) AS n FROM wallets WHERE balance <> 0
    `);
    expect(Number(rows[0].n)).toBeGreaterThan(0);
  });

  it('the ledger is still append-only after everything above', async () => {
    /*
     * The trigger was silently absent for about a month (0028 dropped the table
     * and took its triggers with it; 0120 restored them). A soak is exactly when
     * a guarantee like this is worth re-asking: thousands of writes have just
     * gone through, and "no production path mutates the ledger" is a claim about
     * code, not about the database.
     */
    await expect(
      ctx.db.execute(sql`UPDATE ledger_entries SET amount = amount + 1`),
    ).rejects.toThrow();
    await expect(ctx.db.execute(sql`DELETE FROM ledger_entries`)).rejects.toThrow();
  });
});
