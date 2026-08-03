import { defineConfig } from 'drizzle-kit';

// Migrations are versioned, forward-only, and committed (working agreement).
//   npm run db:generate   diff schema.ts → new SQL migration in src/database/migrations
//   npm run db:migrate    apply pending migrations to DATABASE_URL
export default defineConfig({
  schema: './src/database/schema.ts',
  out: './src/database/migrations',
  dialect: 'postgresql',
  dbCredentials: {
    url: process.env.DATABASE_URL ?? 'postgresql://oxshare:oxshare_dev@localhost:5432/oxshare',
  },
});
