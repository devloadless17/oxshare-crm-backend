import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';

import { MoneyTestContext, startMoneyTestDb, stopMoneyTestDb } from './money-setup';
import { closeDb, resetDb } from '../src/database/db';
import { CATALOG_KEYS } from '../src/common/security/actor';
import { reportPermissionDrift } from '../src/database/permission-drift';

/**
 * The gap that put "Access denied" on the ledger in PRODUCTION, in front of the
 * account that holds every other permission — and the two things that now stop
 * it happening a fourth time.
 *
 * ## What actually goes wrong
 *
 * Permissions are a stored SNAPSHOT. `seed.ts` writes the whole catalog into
 * the `Administrator` role, but with `onConflictDoNothing({ target: roles.name
 * })`, which is deliberate and must stay: a seed that re-widened a role on
 * every boot would silently undo an operator who narrowed it on purpose. So an
 * EXISTING row keeps whatever the catalog held the day it was created, and a
 * key added later reaches nobody.
 *
 * That is invisible to almost every test that could be written about it,
 * because a FRESH database does not have the bug: migrations run, the seed then
 * creates the role from today's catalog, and every key is present. The entire
 * defect lives in the difference between a new database and an old one.
 *
 * So these tests do the one thing that reproduces it — they build a role the
 * way production's is, frozen at an earlier catalog — and then assert on both
 * halves of the answer: the migration that repairs such a row, and the boot
 * check that would have said so out loud the first time.
 *
 * Repaired by hand three times before anything reported it: migrations 0068,
 * 0075 and 0085. Twice it was found by a person hitting a wall in a browser.
 */

const STALE_KEY = 'ledger.view';

/** A logger that records instead of printing, so a test can read what was said. */
function capturingLogger() {
  const errors: string[] = [];
  const warnings: string[] = [];
  return {
    errors,
    warnings,
    logger: {
      error: (message: string) => errors.push(message),
      warn: (message: string) => warnings.push(message),
    } as never,
  };
}

describe('an Administrator role frozen at an older catalog', () => {
  let ctx: MoneyTestContext;

  beforeAll(async () => {
    ctx = await startMoneyTestDb();
    resetDb();
  });

  afterAll(async () => {
    await closeDb();
    await stopMoneyTestDb(ctx);
  });

  beforeEach(async () => {
    await ctx.db.execute(sql`DELETE FROM roles WHERE name = 'Administrator'`);
  });

  /** Seed a role holding today's catalog minus one key — production's shape. */
  async function seedStaleAdministrator(): Promise<void> {
    const stale = CATALOG_KEYS.filter((key) => key !== STALE_KEY);
    // Guards the fixture itself: if `ledger.view` were ever removed from the
    // catalog, this file would otherwise assert nothing while still passing.
    expect(stale.length).toBe(CATALOG_KEYS.length - 1);
    await ctx.db.execute(sql`
      INSERT INTO roles (name, description, permissions)
      VALUES ('Administrator', 'frozen at an older catalog', ${JSON.stringify(stale)}::jsonb)
    `);
  }

  async function heldKeys(): Promise<string[]> {
    const result = await ctx.db.execute<{ permissions: string[] }>(
      sql`SELECT permissions FROM roles WHERE name = 'Administrator'`,
    );
    return result.rows[0]?.permissions ?? [];
  }

  describe('the boot check reports it', () => {
    it('names the missing key, and says what to do about it', async () => {
      await seedStaleAdministrator();
      const { errors, logger } = capturingLogger();

      await reportPermissionDrift(logger);

      expect(errors).toHaveLength(1);
      // The key itself, because "some permissions are missing" sends whoever
      // reads it back to the database to find out which.
      expect(errors[0]).toContain(STALE_KEY);
      // And the remedy, because the person reading `docker logs` at deploy time
      // is not necessarily the person who knows that a migration is the answer.
      expect(errors[0]).toContain('migration');
    });

    it('does NOT repair the row', async () => {
      await seedStaleAdministrator();
      const { logger } = capturingLogger();

      await reportPermissionDrift(logger);

      // The whole point of reporting rather than fixing. Writing the keys here
      // would be the same re-widening `onConflictDoNothing` exists to prevent,
      // except in production, on every boot, with no migration recording that a
      // role's authority changed or who decided it.
      expect(await heldKeys()).not.toContain(STALE_KEY);
    });

    it('says nothing when the role holds the whole catalog', async () => {
      await ctx.db.execute(sql`
        INSERT INTO roles (name, description, permissions)
        VALUES ('Administrator', 'current', ${JSON.stringify(CATALOG_KEYS)}::jsonb)
      `);
      const { errors, warnings, logger } = capturingLogger();

      await reportPermissionDrift(logger);

      // A check that talks on a healthy system is one people filter out, and
      // then it is not a check.
      expect(errors).toEqual([]);
      expect(warnings).toEqual([]);
    });

    it('says nothing when there is no Administrator role at all', async () => {
      const { errors, warnings, logger } = capturingLogger();

      await reportPermissionDrift(logger);

      // A fresh database, or a deployment whose full-access role is named
      // something else. Neither is drift.
      expect(errors).toEqual([]);
      expect(warnings).toEqual([]);
    });
  });

  describe('migration 0085 repairs it', () => {
    /*
     * Replaying the committed migration against a stale row is the only way to
     * test what it is FOR. `startMoneyTestDb` ran it already — on an empty
     * table, where it updated zero rows and proved nothing. Production is the
     * case where the row exists first.
     */
    const migration = readFileSync(
      './src/database/migrations/0085_grant_ledger_view.sql',
      'utf8',
    ).replace(/-->\s*statement-breakpoint/g, '');

    it('grants the missing key to a role that predates it', async () => {
      await seedStaleAdministrator();

      await ctx.db.execute(sql.raw(migration));

      expect(await heldKeys()).toContain(STALE_KEY);
    });

    it('leaves every other permission alone', async () => {
      await seedStaleAdministrator();

      await ctx.db.execute(sql.raw(migration));

      // A grant migration that dropped an unrelated key would hand out one
      // screen and take away another, and the audit log would show neither.
      expect([...(await heldKeys())].sort()).toEqual([...CATALOG_KEYS].sort());
    });

    it('is safe to run twice', async () => {
      await seedStaleAdministrator();

      await ctx.db.execute(sql.raw(migration));
      await ctx.db.execute(sql.raw(migration));

      const keys = await heldKeys();
      expect(keys.filter((key) => key === STALE_KEY)).toHaveLength(1);
    });

    it('does not touch a role somebody else named', async () => {
      await ctx.db.execute(sql`
        INSERT INTO roles (name, description, permissions)
        VALUES ('Payout Reviewer', 'narrowed on purpose', ${JSON.stringify([
          'withdrawals.view',
        ])}::jsonb)
      `);

      await ctx.db.execute(sql.raw(migration));

      const result = await ctx.db.execute<{ permissions: string[] }>(
        sql`SELECT permissions FROM roles WHERE name = 'Payout Reviewer'`,
      );
      // Widening a role an operator built by hand is precisely the thing
      // `onConflictDoNothing` refuses to do; a migration must not do it either.
      expect(result.rows[0]?.permissions).toEqual(['withdrawals.view']);
    });

    it('is silent to the boot check afterwards', async () => {
      await seedStaleAdministrator();
      await ctx.db.execute(sql.raw(migration));
      const { errors, logger } = capturingLogger();

      await reportPermissionDrift(logger);

      // The two halves agree: what the migration repairs is exactly what the
      // check was complaining about.
      expect(errors).toEqual([]);
    });
  });
});
