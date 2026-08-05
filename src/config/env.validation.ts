import { z } from 'zod';

// Config validated once at boot — the process refuses to start on invalid or
// missing configuration instead of failing at 3am on first use (ARCHITECTURE §10,
// working agreement "Configuration"). Wired via ConfigModule.forRoot({ validate }).

/**
 * An optional money bound: a positive, finite decimal STRING.
 *
 * A string rather than a coerced number, because these are monetary values and
 * `money-limits.ts` reads them into decimal.js — coercing here would put the
 * value through a float on the way to the thing that exists to avoid floats.
 */
const decimalLimit = (name: string) =>
  z
    .string()
    .refine(
      (raw) => {
        const value = Number.parseFloat(raw);
        return Number.isFinite(value) && value > 0 && /^\d*\.?\d+$/.test(raw.trim());
      },
      { message: `${name} must be a positive decimal number, e.g. "10" or "0.5"` },
    )
    .optional();

const envSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    PORT: z.coerce.number().int().min(1).max(65535).default(3001),
    PORTAL_URL: z.string().url().default('http://localhost:3000'),
    ADMIN_URL: z.string().url().default('http://localhost:3002'),

    DATABASE_URL: z.string().url().optional(),

    /*
     * The four signing secrets. REQUIRED IN EVERY ENVIRONMENT, not only
     * production, because the dev fallbacks they used to permit are gone: the
     * code reads all four with `getOrThrow`. A fallback here could only ever
     * mask a wiring mistake, and the last one did exactly that — a .env setting
     * `JWT_SECRET` meant every token was signed with a constant published in
     * this repository.
     *
     * FOUR, not three. The admin surface signed both its access and refresh
     * tokens with ADMIN_JWT_SECRET while the portal used a separate key for
     * each, and that asymmetry was a real hole: identical secret, identical
     * `aud`, identical `iss` meant a 30-day admin refresh token verified
     * anywhere a 15-minute access token did. The `typ` claim in
     * common/security/token-audience.ts closes it; this makes the two kinds
     * cryptographically distinct as well, so neither mechanism is load-bearing
     * alone.
     */
    ADMIN_JWT_SECRET: z.string().min(32, 'ADMIN_JWT_SECRET must be at least 32 characters'),
    ADMIN_JWT_REFRESH_SECRET: z
      .string()
      .min(32, 'ADMIN_JWT_REFRESH_SECRET must be at least 32 characters'),
    JWT_ACCESS_SECRET: z.string().min(32, 'JWT_ACCESS_SECRET must be at least 32 characters'),
    JWT_REFRESH_SECRET: z.string().min(32, 'JWT_REFRESH_SECRET must be at least 32 characters'),

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

    /*
     * Redis — single-use replay markers for signed webhooks (§8.4, R-5.3), and
     * the future BullMQ backend. Optional in itself; REQUIRED wherever the
     * bridge secret is set, enforced below.
     */
    REDIS_URL: z.string().url().optional(),

    /*
     * The §12.4 money bounds — validated HERE, at boot.
     *
     * `money-limits.ts` says these are "also validated at boot in
     * env.validation.ts". They were not. Its own reader falls back to the
     * documented default when a value is malformed, which is the safe reading at
     * runtime but means a typo — a stray comma, a currency symbol, a swapped
     * min and max — degrades silently to a number nobody chose, on the ceilings
     * that exist precisely for when the commercial rules are WRONG.
     *
     * A positive finite decimal, or the process does not start.
     */
    WITHDRAWAL_MIN: decimalLimit('WITHDRAWAL_MIN'),
    WITHDRAWAL_MAX: decimalLimit('WITHDRAWAL_MAX'),
    WITHDRAWAL_DAILY_MAX: decimalLimit('WITHDRAWAL_DAILY_MAX'),
    COMMISSION_MAX_PER_DEAL: decimalLimit('COMMISSION_MAX_PER_DEAL'),
    COMMISSION_MAX_SHARE_OF_DEAL: decimalLimit('COMMISSION_MAX_SHARE_OF_DEAL'),
  })
  .passthrough() // unknown keys pass through untouched
  .superRefine((env, ctx) => {
    /*
     * The deal feed cannot run without replay protection.
     *
     * MT5_BRIDGE_SECRET set means the webhook is live, and that endpoint mints
     * commission — an accepted deal becomes an accrual, matures, confirms and
     * pays, with no clawback. Its single-use check needs Redis.
     *
     * Refusing to START is the point. The alternative is a runtime fallback,
     * and a check that disables itself when a dependency is missing is the
     * exact shape of the defect this replaces: the timestamp used to be
     * optional, so omitting a header switched replay protection off.
     */
    if (env.MT5_BRIDGE_SECRET && !env.REDIS_URL) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['REDIS_URL'],
        message:
          'REDIS_URL is required when MT5_BRIDGE_SECRET is set: the deal webhook needs Redis for ' +
          'single-use replay markers (§8.4, R-5.3), and refusing to start beats accepting ' +
          'webhooks that cannot be checked.',
      });
    }

    // Ordering, because each bound is individually valid and collectively
    // nonsense in the two ways that matter: a min above a max refuses every
    // withdrawal, and a daily cap below the single-request cap refuses the
    // second one for a reason the message will not explain.
    const num = (v: unknown) => (typeof v === 'string' ? Number.parseFloat(v) : undefined);
    const min = num(env.WITHDRAWAL_MIN);
    const max = num(env.WITHDRAWAL_MAX);
    const daily = num(env.WITHDRAWAL_DAILY_MAX);

    if (min !== undefined && max !== undefined && min >= max) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['WITHDRAWAL_MIN'],
        message: `WITHDRAWAL_MIN (${env.WITHDRAWAL_MIN}) must be below WITHDRAWAL_MAX (${env.WITHDRAWAL_MAX}); every withdrawal would be refused.`,
      });
    }
    if (max !== undefined && daily !== undefined && daily < max) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['WITHDRAWAL_DAILY_MAX'],
        message: `WITHDRAWAL_DAILY_MAX (${env.WITHDRAWAL_DAILY_MAX}) is below WITHDRAWAL_MAX (${env.WITHDRAWAL_MAX}); the per-request cap could never be reached.`,
      });
    }
  });

/** Secrets that must never be equal to one another — see SIGNING_SECRETS below. */
const SIGNING_SECRETS = [
  'ADMIN_JWT_SECRET',
  'ADMIN_JWT_REFRESH_SECRET',
  'JWT_ACCESS_SECRET',
  'JWT_REFRESH_SECRET',
] as const;

const PROD_REQUIRED = [
  'DATABASE_URL',
  // Mail was optional, and EmailService falls back to `smtp.example.com` with no
  // auth — so a production deploy missing SMTP started cleanly and every
  // verification link, KYC decision and withdrawal notification failed into a
  // catch. CORE-08's withdrawal OTP will fail the same way when it lands. R-8.5's
  // own principle is that config "does not warn, it does not degrade, it
  // refuses"; this is the gap where it warned.
  'SMTP_HOST',
  'SMTP_USER',
  'SMTP_PASS',
  'SMTP_FROM',
  // Absence already fails CLOSED — the MT5 webhook refuses every push without it
  // (an unauthenticated deal feed can mint commission). But it fails at first
  // use, and "no deals are arriving" is a silent revenue outage nobody is paged
  // for. Fail at boot instead.
  'MT5_BRIDGE_SECRET',
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

  /*
   * The four signing secrets must all differ.
   *
   * token-audience.ts names this exact risk and defends against it in the only
   * way it can from inside a token — "the day someone reuses one, in a deploy
   * script, a staging shortcut, a rushed rotation, an admin token silently
   * becomes valid on the client portal and nothing anywhere notices". The `aud`
   * claim turns that into a failed login instead of a privilege escalation,
   * which is a good fallback and not a substitute for noticing.
   *
   * Nothing checked it. A `.env` with the same value pasted into all four
   * validated cleanly, met the 32-character minimum, and started. This is the
   * cheapest possible check for a mistake with no other symptom.
   */
  const seen = new Map<string, string>();
  for (const key of SIGNING_SECRETS) {
    const value = env[key];
    const previous = seen.get(value);
    if (previous) {
      throw new Error(
        `Refusing to start: ${key} and ${previous} are set to the same value. ` +
          'Each signing secret separates one thing from another — the admin surface ' +
          'from the portal, and an access token from a refresh token. Sharing one ' +
          'silently removes that separation. Generate four distinct values ' +
          '(openssl rand -base64 48).',
      );
    }
    seen.set(value, key);
  }

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
