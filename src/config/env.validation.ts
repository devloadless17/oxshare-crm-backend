import { z } from 'zod';

// Config validated once at boot — the process refuses to start on invalid or
// missing configuration instead of failing at 3am on first use (ARCHITECTURE §10,
// working agreement "Configuration"). Wired via ConfigModule.forRoot({ validate }).

const envSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    PORT: z.coerce.number().int().min(1).max(65535).default(3001),
    PORTAL_URL: z.string().url().default('http://localhost:3000'),
    ADMIN_URL: z.string().url().default('http://localhost:3002'),

    // Optional in development (code falls back to dev defaults); required in
    // production — enforced below.
    DATABASE_URL: z.string().url().optional(),
    ADMIN_JWT_SECRET: z
      .string()
      .min(32, 'ADMIN_JWT_SECRET must be at least 32 characters')
      .optional(),
    JWT_ACCESS_SECRET: z
      .string()
      .min(32, 'JWT_ACCESS_SECRET must be at least 32 characters')
      .optional(),
    JWT_REFRESH_SECRET: z
      .string()
      .min(32, 'JWT_REFRESH_SECRET must be at least 32 characters')
      .optional(),

    SMTP_HOST: z.string().optional(),
    SMTP_PORT: z.coerce.number().int().optional(),
    SMTP_USER: z.string().optional(),
    SMTP_PASS: z.string().optional(),
    SMTP_FROM: z.string().optional(),

    // Shared secret with the MT5 bridge (token header + HMAC signature).
    MT5_BRIDGE_SECRET: z
      .string()
      .min(16, 'MT5_BRIDGE_SECRET must be at least 16 characters')
      .optional(),
  })
  .passthrough(); // unknown keys pass through untouched

const PROD_REQUIRED = [
  'DATABASE_URL',
  'ADMIN_JWT_SECRET',
  'JWT_ACCESS_SECRET',
  'JWT_REFRESH_SECRET',
] as const;

export function validateEnv(config: Record<string, unknown>): Record<string, unknown> {
  // The trap that actually happened (3 Aug 2026): a .env set JWT_SECRET, which
  // no code reads, so every token silently signed with the dev defaults.
  // Refuse to start rather than silently ignore it.
  if (config['JWT_SECRET'] && !(config['ADMIN_JWT_SECRET'] && config['JWT_ACCESS_SECRET'])) {
    throw new Error(
      'JWT_SECRET is set but is not read by any code. Use ADMIN_JWT_SECRET (admin tokens) ' +
        'and JWT_ACCESS_SECRET / JWT_REFRESH_SECRET (client tokens) instead — see .env.example.',
    );
  }

  const parsed = envSchema.safeParse(config);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  - ${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('\n');
    throw new Error(`Invalid environment configuration — refusing to start:\n${issues}`);
  }

  const env = parsed.data;
  if (env.NODE_ENV === 'production') {
    const missing = PROD_REQUIRED.filter((k) => !env[k]);
    if (missing.length > 0) {
      throw new Error(
        `Refusing to start in production without: ${missing.join(', ')}. ` +
          'Development fallback secrets are not acceptable in production.',
      );
    }
  }

  return env;
}
