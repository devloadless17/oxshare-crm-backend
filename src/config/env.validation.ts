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

    /*
     * Realtime (WebSocket) transport. See common/realtime/realtime-io.adapter.ts.
     *
     * `uws` runs Socket.IO on uWebSockets.js and needs its OWN port, because
     * Nest serves HTTP through Express and one port has one listener. Setting
     * `node` attaches the socket to the API port instead — the one-variable
     * revert if the native engine ever misbehaves.
     */
    REALTIME_ENGINE: z.enum(['uws', 'node']).default('uws'),
    REALTIME_PORT: z.coerce.number().int().min(1).max(65535).default(3003),

    DATABASE_URL: z.string().url().optional(),

    /*
     * How many reverse proxies WE operate in front of this process.
     *
     * Read by common/security/client-ip.ts, which is the trust boundary for
     * every control that keys on an address: the rate limiter, RBAC-08's IP
     * allowlist, and the audit trail. It was read straight from `process.env`
     * and defaulted silently to 0 — which is correct for local development and
     * wrong for every real deployment, where it means `req.ip` is the PROXY.
     * The limiter then throttles the world as one caller and the allowlist
     * matches the proxy, admitting everyone or no-one.
     *
     * Declared here so the value is validated at boot rather than at first use,
     * and required in production below so somebody has to STATE it. Getting it
     * wrong is a security bug in both directions, so it is not a thing to guess.
     */
    TRUSTED_PROXY_HOPS: z.coerce
      .number()
      .int('TRUSTED_PROXY_HOPS must be a whole number of proxies')
      .min(0, 'TRUSTED_PROXY_HOPS cannot be negative')
      .max(10, 'TRUSTED_PROXY_HOPS above 10 is almost certainly a mistake')
      .optional(),

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

    /*
     * The SMTP env vars are now the BOOTSTRAP configuration, not the only one.
     *
     * `smtp_settings` (one row, admin-editable) overrides all five at runtime.
     * These stay, and stay required in production below, because the override
     * cannot exist before somebody signs in to create it: a fresh deployment
     * must be able to send the admin-invite email that produces the first
     * administrator, and an operator who mis-saves the SMTP form must not lock
     * the system out of its own password-reset flow. Env is the floor.
     */
    SMTP_HOST: z.string().optional(),
    SMTP_PORT: z.coerce.number().int().optional(),
    SMTP_USER: z.string().optional(),
    SMTP_PASS: z.string().optional(),
    SMTP_FROM: z.string().optional(),

    /*
     * Encrypts the secrets this system stores at rest — today the SMTP password
     * in `smtp_settings.password_ciphertext`, via common/security/secret-box.ts.
     *
     * OPTIONAL here and required in production below, which is the same shape as
     * DATABASE_URL and for the same reason: a developer who never opens the SMTP
     * settings screen should not be blocked from booting, while a production
     * deploy that stores a credential under a key nobody set should not start.
     * `secret-box.ts` throws with an actionable message if a write is attempted
     * without it, so the development path fails at the point of use rather than
     * silently storing a password in the clear.
     *
     * 32 characters minimum. It is hashed to a 32-byte key rather than used
     * raw, so the minimum is about entropy rather than about the cipher.
     */
    APP_ENCRYPTION_KEY: z
      .string()
      .min(32, 'APP_ENCRYPTION_KEY must be at least 32 characters')
      .optional(),

    /*
     * Redis — single-use replay markers for signed webhooks (§8.4, R-5.3), and
     * the future BullMQ backend.
     *
     * Unconditionally optional again now that the MT5 bridge is gone. It used to
     * be REQUIRED wherever the bridge secret was set, because the deal webhook
     * could mint commission and its single-use replay check needed Redis. There
     * is no signed webhook left to protect. The Whish and USDT callbacks are the
     * next ones to arrive, and each brings that requirement back with it —
     * as a refinement on ITS own secret, not on a resurrected bridge var.
     */
    REDIS_URL: z.string().url().optional(),

    /*
     * ── Partner commission payout ───────────────────────────────────────────
     *
     * Both optional, and the defaults are the safe ones: hold for a day, run
     * hourly. Declared here so `npm start` fails on a malformed cron rather
     * than booting a scheduler that never fires — a payout job silently not
     * running is the failure nobody notices until a partner asks.
     *
     * HOLD_HOURS stays a STRING on purpose. The service parses it and falls
     * back to the default with a warning on anything it cannot read, because
     * the failure mode of a typo must not be "pay every commission instantly";
     * coercing here would turn that judgement into a boot crash instead.
     */
    IB_COMMISSION_HOLD_HOURS: z
      .string()
      .regex(/^\d+$/, 'IB_COMMISSION_HOLD_HOURS must be a whole number of hours, e.g. 24')
      .optional(),
    IB_COMMISSION_CONFIRM_CRON: z
      .string()
      .regex(
        /^(\S+\s+){4,5}\S+$/,
        'IB_COMMISSION_CONFIRM_CRON must be a cron expression, e.g. "0 0 */4 * * *"',
      )
      .optional(),

    /*
     * ── Whish Money, the first real payment GATEWAY ─────────────────────────
     *
     * All four are optional TOGETHER, and that is the whole design: with any of
     * them missing the Whish method is not offered to clients at all, exactly
     * as a manual method with no `pay_to` is not offered. A gateway nobody can
     * reach must not appear on the deposit screen — a client who picks it and
     * lands on an error has been told the platform is broken.
     *
     * `WhishConfig.isConfigured()` is the single reader of that rule.
     *
     * These are BEARER CREDENTIALS for money movement: `secret` authorises
     * collection against the operator's own Whish account. They belong in a
     * secrets manager, never in client-side code and never in a log line —
     * `whish.provider.ts` never logs a request body for that reason.
     */
    /**
     * Where THIS API is publicly reachable, for provider callbacks.
     *
     * Required alongside the Whish credentials and validated with them, because
     * a gateway payment is created with a callback URL baked in: get this wrong
     * and Whish calls a host that does not exist, so a paid deposit never
     * settles from the provider's side.
     *
     * NOT derived from the inbound request's `Host` header. That value is
     * attacker-influenceable, and this one is handed to a third party who will
     * fetch it later — it has to be something the operator configured.
     *
     * It must be PUBLICLY REACHABLE: `localhost` cannot receive a callback, so
     * local development needs a tunnel (ngrok, cloudflared) pointed here. The
     * client's own browser redirect settles the deposit too, so a missed
     * callback degrades rather than breaks — but only one of those two paths
     * working is not a state to run production in.
     */
    API_PUBLIC_URL: z.string().url().optional(),

    /*
     * The Rival connection's DEVELOPMENT floor. Production config lives in the
     * `rival_settings` row (admin-editable, encrypted at rest), and the row
     * wins WHOLE over these — see `RivalConfigService`. All three optional
     * everywhere: unlike SMTP there is no boot-time chicken-and-egg, a
     * deployment without Rival simply has the whish deposit method
     * unavailable, which the methods list renders honestly.
     *
     * No WHISH_* variables any more, and none may return: Whish credentials
     * live inside Rival, once, for every Loadless merchant system. This CRM
     * holds only a Rival company key.
     *
     * `RIVAL_BASE_URL` includes the /v1 prefix, e.g.
     * https://staging.portal.rivalpayments.com/v1 — staging and production are
     * different hosts, chosen explicitly, never derived from NODE_ENV: a
     * staging deployment is NODE_ENV=production by necessity, and deriving the
     * money API's address from it would silently point staging at live money.
     */
    RIVAL_BASE_URL: z.string().url().optional(),
    RIVAL_API_KEY: z.string().min(1).optional(),
    RIVAL_WEBHOOK_KEY: z.string().min(1).optional(),

    /*
     * ── Object storage (ARCHITECTURE §8.5, PLATFORM-CONVENTIONS R-7.3) ────────
     *
     * Which backend holds uploaded files. Cloudflare R2 is the only production
     * answer; `disk` is the local-filesystem driver for offline dev and the test
     * suite.
     *
     * `disk` IS AN EXPLICIT OPT-IN AND NEVER A FALLBACK, and that is the whole
     * point of validating it here. The obvious wiring — "use R2 when the
     * credentials are present, disk when they are not" — is a silent downgrade: a
     * deployment with one typo'd variable would start cleanly, write every
     * identity document to a container filesystem, and report nothing. R-7.3
     * already names the consequence of documents living on local disk ("losing
     * the API host loses the KYC documents"); arriving there by accident is
     * strictly worse than arriving there on purpose.
     *
     * So: the driver defaults to `r2`, the R2 block is REQUIRED whenever the
     * driver is `r2` (below), and `disk` is refused outright in production. A
     * checkout with no credentials fails to boot with a message naming the
     * one-line fix rather than quietly storing files somewhere else.
     *
     * The four R2 values are all-or-nothing for the same reason — a half-filled
     * block is a mistake, not a configuration.
     */
    STORAGE_DRIVER: z.enum(['r2', 'disk']).default('r2'),
    R2_ACCOUNT_ID: z.string().min(1).optional(),
    R2_ACCESS_KEY_ID: z.string().min(1).optional(),
    R2_SECRET_ACCESS_KEY: z.string().min(1).optional(),
    R2_BUCKET: z.string().min(1).optional(),

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

    /*
     * The R2 block: all four, or none.
     *
     * Checked before the driver requirement below so a partially-filled block
     * reports as a partially-filled block. `STORAGE_DRIVER=disk` with three of
     * four R2 values set is still a mistake worth naming — it is almost always a
     * half-finished edit rather than a decision.
     */
    const R2_KEYS = [
      'R2_ACCOUNT_ID',
      'R2_ACCESS_KEY_ID',
      'R2_SECRET_ACCESS_KEY',
      'R2_BUCKET',
    ] as const;
    const present = R2_KEYS.filter((k) => env[k]);
    if (present.length > 0 && present.length < R2_KEYS.length) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['R2_BUCKET'],
        message:
          `The R2 configuration is incomplete: ${R2_KEYS.filter((k) => !env[k]).join(', ')} ` +
          `${present.length === R2_KEYS.length - 1 ? 'is' : 'are'} missing. All four are needed to ` +
          'reach the bucket, and a half-configured store is a mistake rather than a configuration.',
      });
    }

    /*
     * `STORAGE_DRIVER=r2` (the default) means the credentials must actually exist.
     *
     * This is the check that turns "no R2 config" from a silent downgrade into a
     * refusal. The message names both ways out, because both are legitimate: add
     * the credentials, or state `disk` and accept non-durable local files.
     */
    if (env.STORAGE_DRIVER === 'r2' && present.length === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['STORAGE_DRIVER'],
        message:
          'STORAGE_DRIVER is "r2" (the default) but no R2 credentials are set. Uploaded KYC ' +
          'documents have nowhere durable to go. Either set R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, ' +
          'R2_SECRET_ACCESS_KEY and R2_BUCKET, or set STORAGE_DRIVER=disk to use the local ' +
          'filesystem for development (see .env.example). It is deliberately not inferred: ' +
          'silently writing identity documents to a container filesystem is the failure ' +
          'PLATFORM-CONVENTIONS R-7.3 exists to prevent.',
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
  // Without it the SMTP settings screen cannot store a password at all, and the
  // failure would land on an operator mid-form rather than on the deploy that
  // omitted it. Same principle as the entry above: refuse, do not degrade.
  'APP_ENCRYPTION_KEY',
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

    /*
     * Both frontend URLs must be HTTPS in production, because they are what
     * decides whether SESSION COOKIES ARE SECURE.
     *
     * common/security/session-cookies.ts derives `secure` and the `__Host-`
     * prefix from `isSecureContext()`, which is true only when BOTH of these
     * start with https. Keying on "is this localhost" rather than NODE_ENV is
     * the right instinct — a staging box on HTTPS with NODE_ENV=staging should
     * still get Secure cookies — but nothing enforced the premise, so a single
     * `ADMIN_URL=http://…` in a production env file silently shipped every
     * session cookie without Secure AND without `__Host-`.
     *
     * That is not a degraded mode. `__Host-` is the only part of the cookie
     * design the BROWSER enforces, and it is what stops another site on the
     * oxshare.com registrable domain writing or shadowing this system's session
     * cookies. Losing it silently is exactly the failure that file exists to
     * prevent, so this refuses to start instead.
     */
    const insecureUrls = (['PORTAL_URL', 'ADMIN_URL'] as const).filter(
      (key) => !env[key].startsWith('https://'),
    );
    if (insecureUrls.length > 0) {
      throw new Error(
        `Refusing to start in production with a non-HTTPS ${insecureUrls.join(' and ')}. ` +
          'These two URLs decide whether session cookies are set Secure and `__Host-` prefixed ' +
          '(common/security/session-cookies.ts). With either on http, every session cookie ships ' +
          'without Secure and without the prefix that stops a sibling oxshare.com site ' +
          'overwriting it — and nothing else would report the loss.',
      );
    }

    /*
     * And the proxy hop count must be stated, not defaulted.
     *
     * Checked explicitly rather than via PROD_REQUIRED because 0 is a LEGITIMATE
     * value — a process exposed directly — and `!env[k]` would reject it as
     * missing. The distinction that matters is "somebody chose 0" versus
     * "nobody said", and only the first is safe.
     */
    if (env.TRUSTED_PROXY_HOPS === undefined) {
      throw new Error(
        'Refusing to start in production without TRUSTED_PROXY_HOPS. It is the number of reverse ' +
          'proxies you operate in front of this API — 0 for none, 1 for a single nginx or load ' +
          'balancer, 2 for nginx behind CloudFront. The rate limiter, RBAC-08 IP allowlist and ' +
          'audit trail all key on the address it resolves: too low reads your own proxy, too high ' +
          'lets callers choose their own IP. Set it deliberately (see common/security/client-ip.ts).',
      );
    }

    /*
     * The local filesystem is not a production object store.
     *
     * Refused rather than warned, because the loss is silent and total: files on a
     * container filesystem are not backed up, not replicated, and gone with the
     * host. R-7.3 states the consequence plainly — "losing the API host loses the
     * KYC documents" — and for a regulated broker those documents are the evidence
     * behind every verification decision the business has made.
     *
     * A warning here would be read once, at a deploy, by somebody who is not
     * thinking about backups.
     */
    if (env.STORAGE_DRIVER === 'disk') {
      throw new Error(
        'Refusing to start in production with STORAGE_DRIVER=disk. The local filesystem driver is ' +
          'for offline development and the test suite: files written to it are not backed up, not ' +
          'replicated, and lost with the host (PLATFORM-CONVENTIONS R-7.3). Unset STORAGE_DRIVER ' +
          'and configure the R2 block — Cloudflare R2 is the only production object store.',
      );
    }
  }

  return env;
}
