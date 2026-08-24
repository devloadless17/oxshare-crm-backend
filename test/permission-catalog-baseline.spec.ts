import { describe, expect, it } from 'vitest';
import catalog from '../src/config/permissions.json';
import baseline from '../src/config/permission-catalog.baseline.json';

/**
 * A new permission key must not reach an existing database by accident.
 *
 * ## The failure this gate exists to make impossible
 *
 * Permissions are a stored SNAPSHOT on every role, never a live reference to
 * `permissions.json`. The seed writes the whole catalog into the `Administrator`
 * role — but with `onConflictDoNothing`, deliberately, so that a boot cannot
 * silently re-widen a role an operator narrowed on purpose. `Administrator` is
 * an ORDINARY role (`is_system = false`, and `seed.ts` says so at length:
 * "somebody can read, rename, narrow and delete" it), which is exactly why
 * nothing may repair it automatically.
 *
 * The cost of that correct decision is that an existing role is frozen at
 * whatever the catalog held on the day it was created. Add a key to
 * `permissions.json` and on every already-deployed database it reaches NOBODY.
 * The symptom is a 403 on a screen the full-access account plainly ought to
 * reach, and it compounds: `assertGrantable` refuses to hand out a key the
 * granter does not hold, so nobody on that role can grant it to anyone else
 * either and the gap cannot be closed from inside the console.
 *
 * It has been repaired by hand FOUR times — migrations 0068, 0075, 0085, 0087 —
 * and each one was found by a person hitting the wall in a browser, twice in
 * production. `permission-drift.ts` reports it at boot, which is a good safety
 * net and still a report: it fires after the deploy, in a log, on a system that
 * is already wrong.
 *
 * ## Why a snapshot rather than parsing the migrations
 *
 * The obvious gate — "assert every catalog key is granted by some migration" —
 * cannot be written honestly. Migration SQL mentions permission keys for many
 * reasons other than granting them, so scanning for quoted keys reports 68 of
 * the 73 as "granted" and would pass while the real gap was open. A snapshot has
 * no such ambiguity: it is a list somebody had to edit.
 *
 * Adding a key is therefore two deliberate steps — write the migration that
 * grants it, then record it here. The second step is the one that means "I have
 * thought about the databases that already exist".
 */

/** Every `key` in the catalog, wherever it sits in the module tree. */
function catalogKeys(node: unknown, found: string[] = []): string[] {
  if (Array.isArray(node)) {
    for (const item of node) catalogKeys(item, found);
    return found;
  }
  if (node !== null && typeof node === 'object') {
    const record = node as Record<string, unknown>;
    if (typeof record['key'] === 'string') found.push(record['key']);
    for (const value of Object.values(record)) catalogKeys(value, found);
  }
  return found;
}

const REMEDY =
  '\n\nA key in permissions.json that is NOT in the baseline reaches nobody on any ' +
  'database that already exists — the seed will not re-widen an existing role, by ' +
  'design. Two steps, in order:\n' +
  '  1. Add a migration granting it to the roles that should hold it. Model it on ' +
  'src/database/migrations/0085_grant_ledger_view.sql — it is idempotent and ' +
  'deduplicating.\n' +
  '  2. Add the key to src/config/permission-catalog.baseline.json.\n' +
  'Removing a key is the mirror: drop it from the catalog and from the baseline ' +
  'together, so the two never disagree.';

describe('the permission catalog and its released baseline', () => {
  const declared = [...new Set(catalogKeys(catalog))].sort();
  const released = [...new Set(baseline.keys)].sort();

  /*
   * The new-key case, which is the one that has cost four migrations. It fails
   * the moment somebody adds a key without thinking about existing databases,
   * which is at authorship — not at boot, in production, in a log.
   */
  it('has a migration recorded for every key it declares', () => {
    const unreleased = declared.filter((key) => !released.includes(key));
    expect(unreleased, `permissions.json declares keys the baseline does not.${REMEDY}`).toEqual(
      [],
    );
  });

  /*
   * The mirror. A key removed from the catalog but left here would let the next
   * genuine addition slip through under cover of an already-passing test.
   */
  it('declares every key the baseline records', () => {
    const orphaned = released.filter((key) => !declared.includes(key));
    expect(
      orphaned,
      `the baseline records keys permissions.json no longer declares.${REMEDY}`,
    ).toEqual([]);
  });

  it('records each key exactly once', () => {
    expect(baseline.keys).toHaveLength(new Set(baseline.keys).size);
  });

  /*
   * Not decoration: the file is read by a person who has just been failed by the
   * test above, and the explanation is the whole reason it is a snapshot rather
   * than a bare array.
   */
  it('carries the explanation a reader arrives needing', () => {
    expect(baseline._readme.join(' ')).toMatch(/onConflictDoNothing/);
    expect(baseline._readme.join(' ')).toMatch(/0087/);
  });
});
