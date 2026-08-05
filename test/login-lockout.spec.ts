import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { MoneyTestContext, startMoneyTestDb, stopMoneyTestDb } from './money-setup';
import { closeDb, resetDb } from '../src/database/db';
import { loginAttempts } from '../src/database/schema';
import { LoginAttemptsService } from '../src/common/security/login-attempts.service';

/**
 * PLATFORM-CONVENTIONS R-3.5 — per-ACCOUNT lockout.
 *
 * The per-route `@Throttle` limits were already in place and are keyed on the
 * IP. That bounds one attacker on one address and does nothing about the attack
 * this system actually invites: a distributed credential-stuffing run against a
 * single administrator account, from as many rented addresses as the attacker
 * cares to buy. Those accounts approve and settle payouts.
 *
 * Against real Postgres rather than a fake, because the whole mechanism is one
 * `INSERT ... ON CONFLICT DO UPDATE` with a `CASE` in it: a stub would assert
 * that the code calls a method, not that five failures actually produce a lock.
 */

let ctx: MoneyTestContext;
let service: LoginAttemptsService;

const ADMIN = 'target@oxshare.com';

beforeAll(async () => {
  resetDb();
  ctx = await startMoneyTestDb();
  service = new LoginAttemptsService(ctx.db);
}, 120_000);

afterAll(async () => {
  await closeDb();
  await stopMoneyTestDb(ctx);
});

beforeEach(async () => {
  await ctx.db.delete(loginAttempts);
});

/** Fail `n` times in a row for one identifier. */
async function fail(times: number, identifier = ADMIN, surface: 'admin' | 'portal' = 'admin') {
  for (let i = 0; i < times; i++) await service.recordFailure(surface, identifier);
}

describe('R-3.5 — five failures lock the account, not the IP', () => {
  it('does not lock before the limit', async () => {
    await fail(LoginAttemptsService.MAX_FAILURES - 1);
    expect(await service.lockedFor('admin', ADMIN)).toBeNull();
  });

  it('locks on the fifth failure', async () => {
    await fail(LoginAttemptsService.MAX_FAILURES);
    const remaining = await service.lockedFor('admin', ADMIN);
    expect(remaining).not.toBeNull();
    expect(remaining!).toBeGreaterThan(0);
    expect(remaining!).toBeLessThanOrEqual(LoginAttemptsService.LOCKOUT_MS);
  });

  it('keeps counting past the limit without shortening the lock', async () => {
    // An attacker who keeps hammering must not be able to roll the window.
    await fail(LoginAttemptsService.MAX_FAILURES + 3);
    expect(await service.lockedFor('admin', ADMIN)).not.toBeNull();
  });

  it('is keyed on the ACCOUNT, so a second address is unaffected', async () => {
    // The property the IP-keyed throttler cannot express, and the reason this
    // exists: locking one account must not lock the next admin out too.
    await fail(LoginAttemptsService.MAX_FAILURES);
    expect(await service.lockedFor('admin', 'someone-else@oxshare.com')).toBeNull();
  });

  it('separates the two surfaces — R-3.1', async () => {
    // The same address may exist as a client and as an admin; they are different
    // accounts and one being attacked must not lock the other.
    await fail(LoginAttemptsService.MAX_FAILURES, ADMIN, 'admin');
    expect(await service.lockedFor('portal', ADMIN)).toBeNull();
  });

  it('treats case and surrounding space as the same identifier', async () => {
    // Otherwise `Target@OxShare.com` and `target@oxshare.com` hold independent
    // counters and each stays under the limit forever.
    await fail(3, ADMIN);
    await fail(2, '  TARGET@OxShare.COM  ');
    expect(await service.lockedFor('admin', ADMIN)).not.toBeNull();
  });
});

describe('R-3.5 — a lockout is not a membership oracle', () => {
  it('records failures for an identifier that does not exist', async () => {
    // The natural "optimisation" is to look the account up first and skip the
    // bookkeeping when there is none. That makes "did this lock out?" answer
    // "does this account exist?", handing back exactly what the constant-time
    // login path in password.service.ts was added to remove.
    await fail(LoginAttemptsService.MAX_FAILURES, 'no-such-person@nowhere.test');
    expect(await service.lockedFor('admin', 'no-such-person@nowhere.test')).not.toBeNull();
  });
});

describe('R-3.5 — the lock releases without an administrator', () => {
  it('clears on a successful sign-in', async () => {
    await fail(LoginAttemptsService.MAX_FAILURES - 1);
    await service.recordSuccess('admin', ADMIN);
    await fail(LoginAttemptsService.MAX_FAILURES - 1);
    // The counter restarted, so this is failure 4 of a fresh window, not 8.
    expect(await service.lockedFor('admin', ADMIN)).toBeNull();
  });

  it('expires on its own once the lock window passes', async () => {
    // Self-healing is the property that makes this safe to ship: a lockout an
    // administrator has to clear is a denial of service an attacker can trigger
    // for free against every admin address at once.
    await fail(LoginAttemptsService.MAX_FAILURES);
    expect(await service.lockedFor('admin', ADMIN)).not.toBeNull();

    // Age the row rather than waiting fifteen real minutes.
    await ctx.db.execute(sql`UPDATE login_attempts SET locked_until = now() - interval '1 second'`);
    expect(await service.lockedFor('admin', ADMIN)).toBeNull();
  });

  it('starts a new count when the previous failure is outside the window', async () => {
    await fail(LoginAttemptsService.MAX_FAILURES - 1);
    // Push the last failure out of the 15-minute window.
    await ctx.db.execute(
      sql`UPDATE login_attempts SET updated_at = now() - interval '30 minutes', locked_until = NULL`,
    );

    await fail(1);
    // Failure count restarted at 1, so a forgetful user spread over a day is
    // never locked out.
    expect(await service.lockedFor('admin', ADMIN)).toBeNull();
  });
});

describe('R-3.5 — concurrency', () => {
  it('counts every one of five simultaneous failures', async () => {
    // The reason this is one atomic statement rather than read-then-write: five
    // parallel attempts must produce five failures, not one. A check-then-insert
    // here is the same defect ARCHITECTURE §6 rule 3 forbids on the money path.
    await Promise.all(
      Array.from({ length: LoginAttemptsService.MAX_FAILURES }, () =>
        service.recordFailure('admin', ADMIN),
      ),
    );
    expect(await service.lockedFor('admin', ADMIN)).not.toBeNull();
  });

  it('keeps one row per identifier per surface under concurrency', async () => {
    await Promise.all(Array.from({ length: 8 }, () => service.recordFailure('admin', ADMIN)));
    const rows = await ctx.db.select().from(loginAttempts);
    expect(rows).toHaveLength(1);
  });
});

describe('retention', () => {
  it('sweeps counters whose window has passed', async () => {
    await fail(2);
    await ctx.db.execute(sql`UPDATE login_attempts SET updated_at = now() - interval '1 hour'`);
    expect(await service.sweepExpired()).toBe(1);
    expect(await ctx.db.select().from(loginAttempts)).toHaveLength(0);
  });

  it('leaves a live counter alone', async () => {
    await fail(2);
    expect(await service.sweepExpired()).toBe(0);
  });
});
