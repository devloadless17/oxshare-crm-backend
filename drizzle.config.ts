import 'dotenv/config';
import { defineConfig } from 'drizzle-kit';

// Migrations are versioned, forward-only, and committed (working agreement).
//   npm run db:generate   diff schema.ts → new SQL migration in src/database/migrations
//   npm run db:migrate    apply pending migrations to DATABASE_URL
//
// ── ⚠️ `dotenv/config` FIRST, and the silent failure it fixes ────────────────
//
// Nest loads `.env` through `ConfigModule`; drizzle-kit does NOT. It runs this
// file as a plain script, so `process.env.DATABASE_URL` was undefined and the
// fallback below took over — a DIFFERENT database from the one the application
// uses, whose role does not exist on this machine.
//
// That produced the worst shape a migration tool can have: `npm run db:migrate`
// printed its banner, printed NO error, and exited 1. Nothing said the database
// was unreachable and nothing said no migrations had run, so the dev database
// sat nine migrations behind while the command looked like it had worked.
//
// What eventually surfaced it was the API answering 500 on a payment-method
// create: the code had stopped sending `kind` (migration 0043 drops it) while
// the un-dropped column was still NOT NULL. A schema/code mismatch that the
// migration tool had already been asked to prevent, twice.
//
// The fallback stays for a checkout with no `.env`, but it is now the second
// thing tried rather than the first.
export default defineConfig({
  schema: './src/database/schema.ts',
  out: './src/database/migrations',
  dialect: 'postgresql',
  dbCredentials: {
    url: process.env.DATABASE_URL ?? 'postgresql://oxshare:oxshare_dev@localhost:5432/oxshare',
  },
});
