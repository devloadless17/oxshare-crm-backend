#!/usr/bin/env node
/**
 * A PARTIAL RUN MUST NOT BE ABLE TO REPORT SUCCESS.
 *
 * ## The failure this exists for
 *
 * When vitest cannot start a worker — "Failed to start forks worker", which is
 * what happens when the machine is short of memory — it records an unhandled
 * error, reports the files that DID run as passing, and **exits 0**.
 *
 * Measured on this repo, 10 Sep 2026, uncapped on a busy machine:
 *
 *   17 of 38 files, 165 tests, 21 errors, exit 0   (measured in the portal)
 *   23 of 38 files, 251 tests, 15 errors, exit 0   (measured in the portal)
 *
 * Both are green as far as CI is concerned. The suite answered a question about
 * under half of itself while presenting as complete, and the two runs disagree
 * with each other because the answer depends on how much RAM happened to be
 * free — so the same commit "passes" differently on a busy box and a quiet one.
 *
 * `maxWorkers` in `vitest.config.mts` makes that unlikely. It does not make it
 * impossible: a busier machine, a heavier suite or a future default can bring it
 * back, and it would come back SILENTLY, which is the only reason it went
 * unnoticed for as long as it did.
 *
 * ## Why a floor rather than an exact count
 *
 * An exact count fails every time somebody adds a test file, which trains people
 * to edit the number without reading it — the failure mode of every register in
 * this system. A floor only fails when the suite gets SMALLER, which is either a
 * deleted file (deliberate, so lower the floor in the same commit) or a file that
 * did not run (the bug this catches).
 *
 * Same convention as the coverage thresholds: pinned just under the measured
 * number, and it may only ever go UP.
 *
 * ## What it deliberately does not do
 *
 * It does not assert a test COUNT. Test counts move for legitimate reasons on
 * every commit — a `describe.skipIf` that skips a block in one environment and
 * runs it in another is correct behaviour, not a truncated run. The FILE count is
 * the stable signal: a file either collected or it did not.
 */

import { readFileSync } from 'node:fs';

/**
 * The floor, pinned under the measured 163. Raise it as the suite grows; lower it
 * ONLY in the same commit that deletes a test file, and say which.
 */
const MINIMUM_TEST_FILES = 158;

const REPORT = '.vitest-result.json';

let report;
try {
  report = JSON.parse(readFileSync(REPORT, 'utf8'));
} catch (error) {
  console.error(
    `\nassert-suite-complete: could not read ${REPORT} ` +
      `(${error instanceof Error ? error.message : String(error)}).\n` +
      'The suite is meant to write it via --outputFile.json. Without it this ' +
      'check cannot run, and a check that cannot run must fail rather than pass.\n',
  );
  process.exit(1);
}

const files = Array.isArray(report.testResults) ? report.testResults.length : 0;
/*
 * Worker-start failures land here rather than in any file's results, which is
 * exactly why the run still exits 0 — no test failed, because no test ran.
 */
const unhandled = Array.isArray(report.unhandledErrors) ? report.unhandledErrors.length : 0;

if (files < MINIMUM_TEST_FILES || unhandled > 0) {
  console.error(
    '\n' +
      '─'.repeat(72) +
      '\nINCOMPLETE TEST RUN — refusing to report this as a pass.\n\n' +
      `  test files collected : ${files}\n` +
      `  floor                : ${MINIMUM_TEST_FILES}\n` +
      `  unhandled errors     : ${unhandled}\n\n` +
      'vitest exits 0 when a worker fails to start: the files that ran are\n' +
      'reported as passing and the ones that never started are not reported at\n' +
      'all. If the count is short, the usual cause is memory pressure — check\n' +
      '`maxWorkers` in vitest.config.mts and what else is running on this\n' +
      'machine. If a test file was deliberately deleted, lower the floor in\n' +
      'scripts/assert-suite-complete.mjs in the same commit.\n' +
      '─'.repeat(72) +
      '\n',
  );
  process.exit(1);
}

console.log(`assert-suite-complete: ${files} test files collected (floor ${MINIMUM_TEST_FILES}) ✓`);
