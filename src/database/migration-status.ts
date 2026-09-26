import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

/**
 * Which migrations this BUILD expects, and which of them a database has not
 * run.
 *
 * ## Why this exists
 *
 * Production deploys are manual (DEPLOYMENT.md): pull, build, restart. Nothing
 * in that runs the migrations, so new code can go live against an old schema
 * and fail only when somebody uses the feature — as on 26 Sep 2026, when
 * attaching a group to a second product answered a bare 409 because 0142,
 * which lifted the one-product-per-group rule, had not been applied. The code
 * allowed it; the database still refused it.
 *
 * `/health/ready` and the startup log now say so plainly instead.
 */
export interface JournalEntry {
  idx: number;
  /** Drizzle's `folderMillis`: what `drizzle.__drizzle_migrations.created_at` stores. */
  when: number;
  tag: string;
}

/*
 * Where the journal is, from each place this code runs: the backend folder as
 * the working directory (the production box, Docker's /app), the TypeScript
 * source (tests), and a compiled `dist/database`.
 */
const JOURNAL_CANDIDATES = [
  join(process.cwd(), 'src', 'database', 'migrations', 'meta', '_journal.json'),
  resolve(__dirname, 'migrations', 'meta', '_journal.json'),
  resolve(__dirname, '..', '..', 'src', 'database', 'migrations', 'meta', '_journal.json'),
];

let shipped: JournalEntry[] | null | undefined;

/** The migrations this build ships, in order — or null when the journal is not on disk. */
export function shippedMigrations(): JournalEntry[] | null {
  if (shipped !== undefined) return shipped;
  const path = JOURNAL_CANDIDATES.find((candidate) => existsSync(candidate));
  if (!path) {
    shipped = null;
    return shipped;
  }
  const journal = JSON.parse(readFileSync(path, 'utf8')) as { entries?: JournalEntry[] };
  shipped = (journal.entries ?? []).map(({ idx, when, tag }) => ({ idx, when, tag }));
  return shipped;
}

/**
 * The shipped migrations a database has not run.
 *
 * Drizzle's own rule: a migration is applied when its `when` is at or before
 * the newest `created_at` in `drizzle.__drizzle_migrations`. A database that
 * has run nothing (`lastAppliedAt` null) is missing every one.
 */
export function pendingMigrations(
  entries: readonly JournalEntry[],
  lastAppliedAt: number | null,
): JournalEntry[] {
  if (lastAppliedAt === null) return [...entries];
  return entries.filter((entry) => entry.when > lastAppliedAt);
}
