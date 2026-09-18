import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { AUDIT_ACTION_KEYS, AUDIT_ACTIONS } from '../src/modules/admin/audit-actions.catalog';

/**
 * A DECLARED action must actually be WRITTEN somewhere.
 *
 * ── The gap this closes ────────────────────────────────────────────────────
 *
 * `audit-coverage.spec.ts` asserts that every mutating admin route declares a
 * stance — `@Audited('x')` or `@NotAudited(why)`. That test reads Nest
 * metadata, and metadata is a promise rather than a behaviour: NOTHING READS
 * `AUDIT_KEY` AT RUNTIME. There is no interceptor behind the decorator. So a
 * route could carry `@Audited('currency.create')`, satisfy that spec in full,
 * and write nothing at all — which is exactly what seventeen routes across five
 * feature modules did. The decorator was documentation that looked like
 * machinery.
 *
 * `audit-completeness.spec.ts` closes the same gap from the other end, by
 * driving real HTTP and reading the table. That is the stronger evidence and it
 * is also the expensive kind: it needs a container, a seeded admin, and a
 * request per action, so it will only ever cover a handful of the fifty-odd
 * actions this system records.
 *
 * This file covers ALL of them, statically and in milliseconds. The two are
 * complementary: this one proves a `record()` call EXISTS for every declared
 * action, and the HTTP suite proves the call is actually REACHED on the routes
 * it exercises. Neither subsumes the other — a `record()` call sitting in dead
 * code would pass here and fail there.
 *
 * ── Why static analysis is honest enough here ──────────────────────────────
 *
 * The question being asked is narrow: does the string in `@Audited('x')`
 * appear as the action argument of a `record`/`recordWithin` call anywhere in
 * `src/`? That is a question about the SOURCE, and reading the source answers
 * it directly. The failure mode it is built to catch is a whole service with no
 * audit code in it, which no amount of subtlety can hide from a grep.
 */

const SRC = join(__dirname, '..', 'src');

/** Every .ts file under src/, so a new module cannot escape by being new. */
function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      out.push(...sourceFiles(full));
    } else if (entry.endsWith('.ts') && !entry.endsWith('.d.ts')) {
      out.push(full);
    }
  }
  return out;
}

/**
 * Comments are stripped before anything is matched.
 *
 * This file's own subject matter is heavily commented — `audit-actions.catalog.ts`
 * discusses `@Audited('…')` in prose, and its ellipsis parsed as an action named
 * "…" the first time this ran. A doc comment describing the mechanism must not
 * register as a use of it, in either direction: prose mentioning `record('x')`
 * would otherwise satisfy the requirement that x be recorded, which is precisely
 * the "documentation that looks like machinery" defect this file exists to catch.
 *
 * The same technique `check:twins` uses, and for the same reason.
 */
function stripComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

const FILES = sourceFiles(SRC);
const SOURCES = FILES.map((path) => ({
  path,
  text: stripComments(readFileSync(path, 'utf8')),
}));
const ALL_SOURCE = SOURCES.map((s) => s.text).join('\n');

/**
 * Every action string a route DECLARES via `@Audited('…')`.
 *
 * Read from the text rather than from Nest metadata on purpose: this file must
 * run without booting the application, so that a failure here points at a
 * missing `record()` call and never at a module that would not resolve.
 * `audit-coverage.spec.ts` already checks these same declarations against the
 * live metadata, so the two spellings are kept honest against each other.
 */
function declaredActions(): Map<string, string[]> {
  const byAction = new Map<string, string[]>();
  for (const { path, text } of SOURCES) {
    for (const match of text.matchAll(/@Audited\(\s*'([^']+)'\s*\)/g)) {
      const action = match[1];
      const where = byAction.get(action) ?? [];
      where.push(relative(SRC, path).replace(/\\/g, '/'));
      byAction.set(action, where);
    }
  }
  return byAction;
}

/**
 * Every action string that is WRITTEN — the literals passed as the `action`
 * argument of `record(...)` or `recordWithin(...)`.
 *
 * ── The false-positive traps, and how each is handled ──────────────────────
 *
 * The matcher has to be generous, because a test that reports a working action
 * as missing gets muted rather than fixed. Three real shapes in this codebase
 * would defeat a naive regex:
 *
 *   1. `record(actor.id, 'client_tag.create', …)`      — the ordinary case.
 *   2. `recordWithin(tx, actor.id, 'withdrawal.approve', …)` — an extra leading
 *      argument, so the action is in a different position.
 *   3. `record(actor.id, status === 'suspended' ? 'client.suspend' : 'client.activate', …)`
 *      — TWO actions from one call site, neither in a fixed position.
 *
 * So rather than parsing arguments positionally, this takes the text of each
 * `record`/`recordWithin` call and collects EVERY single-quoted literal in it
 * that looks like an action name. A ternary yields both of its branches, which
 * is correct: both are genuinely recorded.
 *
 * That is deliberately over-inclusive — a subject type like `'client_tag'` has
 * no dot and is filtered out by the shape, but a details key that happened to
 * look like `'a.b'` would be counted. The consequence of over-inclusion is a
 * missed gap, not a false alarm; the consequence of under-inclusion is a red
 * build on working code, which is the failure that gets a test deleted. Between
 * the two, this errs toward the one that keeps the suite trusted — and the
 * expensive HTTP suite is the backstop for the rest.
 *
 * An action passed as a VARIABLE (`record(id, action, …)`) is invisible here.
 * Nothing in `src/` does that today; if something starts to, its action will
 * report as unrecorded and the fix is to name the literal or to widen this.
 */
function recordedActions(): Set<string> {
  const found = new Set<string>();

  /*
   * `record(` / `recordWithin(` and everything up to the matching close paren,
   * counted by depth so a nested `{ … ( … ) … }` details object does not end
   * the call early.
   */
  const opener = /\brecord(?:Within)?\s*\(/g;
  for (const { text } of SOURCES) {
    for (const start of text.matchAll(opener)) {
      const from = (start.index ?? 0) + start[0].length;
      let depth = 1;
      let i = from;
      while (i < text.length && depth > 0) {
        const ch = text[i];
        if (ch === '(') depth += 1;
        else if (ch === ')') depth -= 1;
        i += 1;
      }
      const args = text.slice(from, i - 1);
      for (const literal of args.matchAll(/'([a-z_]+\.[a-z_.]+)'/g)) {
        found.add(literal[1]);
      }
    }
  }

  /*
   * Actions reached through a POLICY OBJECT rather than named at the call.
   *
   * `uploads.controller.ts` serves two buckets through one handler shape and
   * passes `audit: { action: 'kyc.document.view', subjectType: … }` into
   * `recordRead`, so the action literal is nowhere near a `record(` call. The
   * scan above cannot see it, and the catalogued-to-written check below
   * therefore reported both as dead when they are written on every document a
   * reviewer opens.
   *
   * Matching the declaration shape is closer to the truth than exempting the two
   * by name: a third bucket added tomorrow is found the same way, where a
   * hand-kept exemption list would not know about it.
   */
  for (const { path, text } of SOURCES) {
    /*
     * NOT the catalogue itself. Its entries are `{ action: 'x', label: … }`, so
     * scanning it would make every catalogued action look recorded and turn the
     * check below into a tautology — the exact failure shape this suite exists
     * to find elsewhere.
     */
    if (path.endsWith('audit-actions.catalog.ts')) continue;
    for (const literal of text.matchAll(/\baction:\s*'([a-z_]+\.[a-z_.]+)'/g)) {
      found.add(literal[1]);
    }
  }

  return found;
}

describe('the @Audited decorator names an action that is actually written', () => {
  it('finds the declarations and the calls, so it cannot pass vacuously', () => {
    // The guard on the whole file. If either regex stopped matching — a
    // refactor to double quotes, a rename of `record` — every assertion below
    // would pass by finding nothing, which is the one failure a coverage test
    // must not have.
    expect(declaredActions().size).toBeGreaterThanOrEqual(40);
    expect(recordedActions().size).toBeGreaterThanOrEqual(40);
  });

  it('writes a row for every action a route declares', () => {
    const recorded = recordedActions();
    const missing = [...declaredActions().entries()]
      .filter(([action]) => !recorded.has(action))
      .map(([action, where]) => `  ${action}  — declared on ${where.join(', ')}`);

    expect(
      missing,
      'These routes carry @Audited(...) and NOTHING in src/ writes the action. The decorator ' +
        'is metadata — no interceptor reads AUDIT_KEY at runtime — so the declaration alone ' +
        'records nothing, and the audit screen shows "no results" for an action that reads as ' +
        '"it never happened" (D-21). Call `this.audit.record(actor.id, "<action>", ...)` in the ' +
        `service, with the action spelled EXACTLY as the decorator declares it:\n${missing.join('\n')}`,
    ).toEqual([]);
  });

  it('has a catalog entry for every action it writes', () => {
    /*
     * The other direction, and a real gap of its own: an action that is
     * recorded but absent from `AUDIT_ACTIONS` cannot be FILTERED FOR on the
     * audit screen. `audit-coverage.spec.ts` checks this against the decorator
     * declarations; this checks it against what the code actually writes, which
     * also covers the recorded actions that have no route at all (the exports,
     * and `admin.invite_accept`, which happens on a public invite route).
     */
    const uncatalogued = [...recordedActions()]
      .filter((action) => !AUDIT_ACTION_KEYS.has(action))
      .sort();

    expect(
      uncatalogued,
      'These actions are written to audit_log and are missing from AUDIT_ACTIONS, so an ' +
        'operator cannot filter for them and reads their absence as "it never happened":\n' +
        uncatalogued.map((a) => `  ${a}`).join('\n'),
    ).toEqual([]);
  });

  it('leaves no feature module with audited routes and no audit code', () => {
    /*
     * The shape of the original defect, stated directly.
     *
     * Every one of the seventeen unrecorded actions lived in a module whose
     * SERVICES contained no audit code whatsoever — currencies, IB levels, IB
     * applications, payment methods, settings. The per-action check above would
     * catch that too, but this one names the module rather than the action,
     * which is the level at which somebody fixes it.
     */
    const offenders: string[] = [];
    for (const { path, text } of SOURCES) {
      if (!/@Audited\(/.test(text)) continue;
      const moduleDir = join(path, '..');
      const siblings = readdirSync(moduleDir).filter((f) => f.endsWith('.ts'));
      const moduleHasAuditCall = siblings.some((f) =>
        /\brecord(?:Within)?\s*\(/.test(stripComments(readFileSync(join(moduleDir, f), 'utf8'))),
      );
      if (!moduleHasAuditCall) offenders.push(relative(SRC, path).replace(/\\/g, '/'));
    }

    expect(
      [...new Set(offenders)],
      'These files declare audited routes and nothing in their directory calls the audit ' +
        'writer at all — the signature of a module where the decorator was added and the ' +
        'record() call never was:\n' +
        offenders.map((o) => `  ${o}`).join('\n'),
    ).toEqual([]);
  });
});

/**
 * A guard on the guard: the source really is being read.
 *
 * If `sourceFiles` silently returned nothing — a moved directory, a changed
 * layout — every check above would pass while looking at an empty tree.
 */
describe('the scan reads the source tree', () => {
  it('finds the services it is meant to be checking', () => {
    expect(FILES.length).toBeGreaterThan(50);
    expect(ALL_SOURCE).toContain('AdminAuditService');
  });
});

describe('the catalogue names nothing that no code writes', () => {
  it('has no action that is neither recorded nor marked historical', () => {
    /*
     * The direction this file never checked.
     *
     * It asserts written→catalogued (an action `record()`ed but absent from the
     * catalogue is unfilterable) and said nothing about catalogued→written. Five
     * entries were in the second state: `ib.program_change`, `ib_level.reorder`
     * and the three `ib_program.*`. Each renders in the console's action filter
     * as a selectable option that can only ever answer "no results" — which an
     * operator reads as "that never happened".
     *
     * ## Why they are marked rather than deleted
     *
     * Because "no code writes it" and "no row carries it" are different claims.
     * `ib_program.*` were written on every programme edit until migration 0112
     * retired the catalogue they described, so rows exist — and this file's
     * subject exists so an auditor can ask "has anyone ever done X". Deleting the
     * label makes the historical rows unfilterable, which is the defect the
     * catalogue was built to prevent, arriving from the other side.
     *
     * So `historical: true` is the statement, and this is what forces a NEW dead
     * entry to be one or the other rather than neither.
     */
    const recorded = recordedActions();
    const orphaned = AUDIT_ACTIONS.filter(
      (entry) => !entry.historical && !recorded.has(entry.action),
    ).map((entry) => entry.action);

    expect(
      orphaned,
      'These actions are in the catalogue and no code records them, so the audit filter ' +
        'offers them and they can never return a result. Record the action, delete the ' +
        'entry, or mark it `historical: true` if rows already carry it:\n' +
        orphaned.map((a) => `  ${a}`).join('\n'),
    ).toEqual([]);
  });

  it('marks nothing historical that code still writes', () => {
    /*
     * The other half, and the one that stops `historical` becoming a way to
     * silence the check above. An action still being written is not historical,
     * whatever the label says.
     */
    const recorded = recordedActions();
    const alive = AUDIT_ACTIONS.filter(
      (entry) => entry.historical && recorded.has(entry.action),
    ).map((entry) => entry.action);

    expect(
      alive,
      `These are marked historical and are still recorded by live code:\n${alive.join('\n')}`,
    ).toEqual([]);
  });
});
