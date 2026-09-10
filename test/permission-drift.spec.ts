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
  const logs: string[] = [];
  return {
    errors,
    warnings,
    logs,
    logger: {
      error: (message: string) => errors.push(message),
      warn: (message: string) => warnings.push(message),
      // Required, not decoration: the repair reports at `log` level, and a stub
      // missing the method throws inside the function's own try/catch — which
      // would surface as a swallowed warning and a test failing for the wrong
      // reason entirely.
      log: (message: string) => logs.push(message),
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
    // `is_system` is what the boot check matches on now — it used to match the
    // NAME. A fixture that omits the flag is a role the repair correctly ignores,
    // which would make every case below pass by asserting nothing.
    await ctx.db.execute(sql`
      INSERT INTO roles (name, description, permissions, is_system)
      VALUES ('Administrator', 'frozen at an older catalog', ${JSON.stringify(stale)}::jsonb, true)
    `);
  }

  /** Every role EXCEPT the top one, by name, so a snapshot can be compared. */
  async function otherRoles(): Promise<{ name: string; permissions: string[] }[]> {
    const result = await ctx.db.execute<{ name: string; permissions: string[] }>(
      sql`SELECT name, permissions FROM roles WHERE name <> 'Administrator' ORDER BY name`,
    );
    return result.rows;
  }

  async function heldKeys(): Promise<string[]> {
    const result = await ctx.db.execute<{ permissions: string[] }>(
      sql`SELECT permissions FROM roles WHERE name = 'Administrator'`,
    );
    return result.rows[0]?.permissions ?? [];
  }

  describe('the boot check repairs it', () => {
    /*
     * The behaviour reversed on 24 Aug 2026, on the owner's decision:
     * `Administrator` is the TOP-LEVEL role inside the system, so the catalog is
     * its definition rather than a suggestion. The old pair of cases here
     * asserted that it named the gap and left the row alone — correct while
     * "an operator narrowed this deliberately" was a case worth preserving, and
     * wrong once it is not a supported operation at all.
     */
    it('GRANTS the missing key, so the gap is closed rather than announced', async () => {
      await seedStaleAdministrator();
      const { logger } = capturingLogger();

      await reportPermissionDrift(logger);

      expect(await heldKeys()).toContain(STALE_KEY);
    });

    it('names every key it granted, because granting authority needs an author', async () => {
      await seedStaleAdministrator();
      const { logs, logger } = capturingLogger();

      await reportPermissionDrift(logger);

      expect(logs).toHaveLength(1);
      // The key itself — "some permissions were granted" sends whoever reads it
      // back to the database to find out which.
      expect(logs[0]).toContain(STALE_KEY);
    });

    /*
     * ADDS only. A key somebody put on the role by hand that the catalog does
     * not define must survive: this closes a gap, it does not enforce equality,
     * and tidying away a key nobody asked about is the destructive half of
     * "sync" that this deliberately is not.
     */
    it('keeps a key the catalog does not define', async () => {
      const stale = CATALOG_KEYS.filter((key) => key !== STALE_KEY);
      await ctx.db.execute(sql`
        INSERT INTO roles (name, description, permissions, is_system)
        VALUES ('Administrator', 'hand-edited',
                ${JSON.stringify([...stale, 'legacy.custom.key'])}::jsonb, true)
      `);
      const { logger } = capturingLogger();

      await reportPermissionDrift(logger);

      const held = await heldKeys();
      expect(held).toContain(STALE_KEY); // the gap closed
      expect(held).toContain('legacy.custom.key'); // and nothing was tidied away
    });

    it('is safe to run twice, and says nothing the second time', async () => {
      await seedStaleAdministrator();
      const first = capturingLogger();
      await reportPermissionDrift(first.logger);

      const second = capturingLogger();
      await reportPermissionDrift(second.logger);

      // Boot happens on every deploy and every restart. A repair that announced
      // itself forever would be filtered out, and then it is not a signal.
      expect(second.logs).toEqual([]);
      expect(await heldKeys()).toContain(STALE_KEY);
    });

    it('says nothing when the role holds the whole catalog', async () => {
      await ctx.db.execute(sql`
        INSERT INTO roles (name, description, permissions, is_system)
        VALUES ('Administrator', 'current', ${JSON.stringify(CATALOG_KEYS)}::jsonb, true)
      `);
      const { errors, warnings, logs, logger } = capturingLogger();

      await reportPermissionDrift(logger);

      // A check that talks on a healthy system is one people filter out, and
      // then it is not a check.
      expect(errors).toEqual([]);
      expect(warnings).toEqual([]);
      expect(logs).toEqual([]);
    });

    /*
     * ⚠️ THE BLAST-RADIUS TEST. Every other role is narrow ON PURPOSE — a
     * Support Agent lacking `payments.edit` is the role, not drift — so widening
     * one would be exactly the destructive act this module was first written to
     * refuse. Only the top role is the catalog's.
     */
    it('leaves every other role untouched', async () => {
      // Removed first AND after: `beforeEach` clears only `Administrator`, and
      // `roles.name` is unique — a leftover row would fail the file's SECOND run
      // on the same database with a constraint error that says nothing about
      // what this test is for.
      await ctx.db.execute(sql`DELETE FROM roles WHERE name LIKE 'Drift Bystander%'`);
      /*
       * THREE bystanders, and they exist because of how this test first failed
       * to earn its place. With one, deleting the role filter from the query
       * still left it passing: the read took `limit(1)`, so a mutant that
       * widened "whichever role comes back first" happened to pick the top role
       * anyway and the bystander was untouched by luck.
       *
       * Several rows plus a full before/after comparison removes the luck: any
       * mutant that updates a role chosen by anything other than `is_system`
       * moves one of these, and the snapshot says which. The `limit(1)` is gone
       * now — the repair loops over every system role — so dropping the filter
       * would widen all three at once rather than one by chance.
       */
      for (const n of [1, 2, 3]) {
        await ctx.db.execute(sql`
          INSERT INTO roles (name, description, permissions)
          VALUES (${'Drift Bystander ' + String(n)}, 'narrow on purpose',
                  ${JSON.stringify(['clients.view'])}::jsonb)
        `);
      }
      const before = await otherRoles();
      const { logger } = capturingLogger();

      await reportPermissionDrift(logger);

      expect(await otherRoles()).toEqual(before);
      await ctx.db.execute(sql`DELETE FROM roles WHERE name LIKE 'Drift Bystander%'`);
    });

    it('says nothing when there is no system role at all', async () => {
      const { errors, warnings, logger } = capturingLogger();

      await reportPermissionDrift(logger);

      // A fresh database whose seed is about to create one. Not drift.
      expect(errors).toEqual([]);
      expect(warnings).toEqual([]);
    });

    /*
     * ⚠️ THE FLAG IS THE RULE — the pair below is the whole of this change, and
     * each half fails differently if it regresses.
     *
     * The repair used to match `WHERE name = 'Administrator'`, a magic string
     * against a row that said `is_system = false`. So the role was special in
     * fact and ordinary in the data: renaming it in the console silently stopped
     * the top-up, and the reasoning had to live in a comment because the schema
     * did not record it.
     */
    it('IGNORES a role named Administrator that is not flagged', async () => {
      // The exact row the old implementation would have widened. An operator who
      // creates a narrow role and happens to call it this must not be handed
      // every permission in the catalog by a name collision.
      const stale = CATALOG_KEYS.filter((key) => key !== STALE_KEY);
      await ctx.db.execute(sql`
        INSERT INTO roles (name, description, permissions, is_system)
        VALUES ('Administrator', 'ordinary despite the name',
                ${JSON.stringify(stale)}::jsonb, false)
      `);
      const { logs, logger } = capturingLogger();

      await reportPermissionDrift(logger);

      expect(await heldKeys()).not.toContain(STALE_KEY);
      expect(logs).toEqual([]);
    });

    it('REPAIRS a system role whatever it is called', async () => {
      // The other half: the rule follows the flag, so renaming the top role can
      // no longer switch the top-up off without anyone noticing.
      await ctx.db.execute(sql`DELETE FROM roles WHERE name = 'Renamed Top Role'`);
      const stale = CATALOG_KEYS.filter((key) => key !== STALE_KEY);
      await ctx.db.execute(sql`
        INSERT INTO roles (name, description, permissions, is_system)
        VALUES ('Renamed Top Role', 'still the catalog''s',
                ${JSON.stringify(stale)}::jsonb, true)
      `);
      const { logs, logger } = capturingLogger();

      await reportPermissionDrift(logger);

      const held = await ctx.db.execute<{ permissions: string[] }>(
        sql`SELECT permissions FROM roles WHERE name = 'Renamed Top Role'`,
      );
      expect(held.rows[0]?.permissions).toContain(STALE_KEY);
      // Named in the log, and named by ITS name rather than a hardcoded one.
      expect(logs[0]).toContain('Renamed Top Role');

      await ctx.db.execute(sql`DELETE FROM roles WHERE name = 'Renamed Top Role'`);
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
