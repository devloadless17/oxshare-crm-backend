import { z } from 'zod';
import { resolveGoogleOauth } from './google-oauth';

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

/**
 * Every environment this service will start in — and therefore, by omission,
 * every environment it refuses.
 *
 * NAMED rather than inlined into the schema because two other files depend on
 * the set being exactly this, and neither can see a literal buried in a zod
 * call. `app.module.ts` mounts the unauthenticated `E2eFixturesModule`, and
 * `main.ts` runs `runSeeds()` (a known-password admin), behind
 * `NODE_ENV !== 'production'` — a DENYLIST, which is the shape
 * `admin-auth.service.ts` abandoned after it leaked an invite token on staging
 * because it "also matched 'staging' and every typo".
 *
 * What makes the denylist safe here is this list, and only this list: a box set
 * to anything outside it does not serve those routes, it refuses to boot. Add a
 * fourth environment and that stops being true — the denylist would admit it.
 *
 * `test/dev-only-modules-env.spec.ts` imports this and pins it, so widening the
 * set is a red build rather than a one-word edit. Give `app.module.ts` and
 * `main.ts` a real allowlist first.
 */
export const NODE_ENVIRONMENTS = ['development', 'test', 'production'] as const;

const envSchema = z
  .object({
    NODE_ENV: z.enum(NODE_ENVIRONMENTS).default('development'),

    /*
     * Seed the end-to-end FIXTURES (`e2e-*` accounts, the @oxshare-e2e.test
     * client cohort, their tags and roles). Default `true`, because both
     * frontends' Playwright suites sign in as those identities.
     *
     * Declared HERE rather than read straight off `process.env`, and that is not
     * a style point: `ConfigModule` parses `.env` into an object, validates it,
     * and assigns only the VALIDATED keys to `process.env` — so a variable
     * missing from this schema is silently dropped and reads as undefined
     * however it is set in the file.
     */
    SEED_E2E_FIXTURES: z.enum(['true', 'false']).default('true'),

    /**
     * Relax the rate-limit COUNTER for an end-to-end run. Never in production.
     *
     * The browser suites drive real sign-ins, and the caps they meet are real —
     * admin login 5/min, portal login 5/min, register 10/hour. Their answer has
     * always been to WAIT the window out, which is correct for a suite proving
     * the product behaves, and costs about 5.4 minutes of pure sleeping in a
     * 20-minute CI job. It is also the single largest source of flakes this
     * suite has: today alone, a rate limit was reported as "the NEW password
     * does not sign in", as "accept answered 429", as a navigation timeout, and
     * as a screen missing the words "already verified".
     *
     * So this swaps the COUNTER and leaves the GUARD wired — exactly what
     * `test/http-setup.ts` already does for the unit suites, and for the same
     * stated reason: a wiring mistake that stops ThrottlerGuard running must
     * still fail, and it does, because the guard still resolves its per-route
     * limits and builds its key on every request.
     *
     * WHAT THIS COSTS, stated rather than hidden: an E2E run no longer exercises
     * the real limits. That is acceptable only because three backend suites do —
     * `credential-route-throttling`, `bridge-webhook-throttling` and
     * `redis-throttler-storage` — and because no E2E spec asserts 429 behaviour,
     * which was checked rather than assumed before this was added.
     */
    RELAX_RATE_LIMITS: z
      .enum(['1', 'true'])
      .optional()
      .describe('E2E only: permissive rate-limit counter. Refused in production.'),
    PORT: z.coerce.number().int().min(1).max(65535).default(3001),
    PORTAL_URL: z.string().url().default('http://localhost:3000'),
    ADMIN_URL: z.string().url().default('http://localhost:3002'),

    /*
     * Print emailed LINKS to the log instead of relying on a mailbox — local
     * testing only.
     *
     * SMTP is admin-configured (there are no SMTP_* variables, see below), so a
     * developer with no relay configured gets no verification link and no
     * password-reset link at all — and test fixtures use addresses like
     * `@oxtest.local` that could never receive one anyway. The alternative is
     * reading tokens out of the database by hand, which is how somebody ends up
     * writing a query that also works in production.
     *
     * ⚠️ THIS PRINTS SECRETS. A verification or reset link IS the credential —
     * anyone who can read the log can take over the account. That is why
     * `EmailService` normally logs the recipient and nothing else (R-6.3), and
     * why this is REFUSED in production below rather than merely discouraged.
     */
    LOG_EMAIL_LINKS: z
      .enum(['true', 'false'])
      .default('false')
      .transform((v) => v === 'true'),

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

    /*
     * What happens to a response key its declared DTO does not name — see
     * common/security/response-projection.interceptor.ts.
     *
     * `enforce` (the default under NODE_ENV=test) answers it with a 500, so every
     * HTTP spec is also a completeness check. `strip` (the default everywhere
     * else) removes it and logs once per route and key: a leak prevented, a DTO
     * gap reported. `report` logs and changes nothing — the census mode, run once
     * to list every gap before enforcement was switched on.
     */
    RESPONSE_PROJECTION: z.enum(['enforce', 'strip', 'report']).optional(),

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
     * ── Partner commission payout: NOT CONFIGURED HERE ──────────────────────
     *
     * `IB_COMMISSION_HOLD_HOURS` and `IB_COMMISSION_CONFIRM_CRON` were declared
     * and validated here long after anything read them. 0113 moved the whole
     * cadence onto `trading_settings.ib_commission_interval_seconds` — the "Pay
     * commission every" control on the Trading settings tab — and
     * `CommissionService` reads that; `IB_DEAL_ACCRUAL_CRON` followed in 0114
     * so that both halves of the pipeline are configured in one place instead
     * of half a form and half a deploy.
     *
     * Removing them is not tidying. A variable that boots, validates, and is
     * read by nothing is worse than absent: it is set in a real `.env`,
     * somebody changes it to alter a payout schedule, the app accepts it
     * without complaint, and the schedule does not move. The next person
     * debugging why has a validated setting that says it is in force.
     *
     * ⚠️ Deliberately NOT re-added as a fallback for the setting. Two sources
     * for one cadence is the disagreement 0113 existed to end.
     */
    /*
     * How often ingested MT5 deals are turned into accruals. Every minute by
     * default, and validated here for the reason stated above: a typo that
     * boots a scheduler which never fires would leave every deal queued and
     * every partner unpaid, with nothing in any log to say so.
     *
     * Like the confirm cron, this is not a correctness control. A deal not
     * reached stays queued rather than being skipped, and the accrual is
     * idempotent, so running this less often delays a partner's pending balance
     * and cannot change what they are owed.
     */
    /**
     * WHICH deals the commission engine is allowed to pay for — the one setting
     * that must be chosen rather than defaulted.
     *
     * `mt5_deals` is filled by ingestion, which has been running since long
     * before anything read it. So the first run of the accrual job faces a
     * backlog of historical trades and, left alone, pays partners for every one
     * of them — months of commission, all at once, from a job whose whole
     * design is to be safe to run. That is not a bug in the engine; it is a
     * commercial decision nobody has been asked to make.
     *
     *   <ISO date>  pay for deals dealt at or after this instant. Anything
     *               older is marked decided and accrues nothing.
     *   all         pay for the entire backlog, deliberately.
     *   (unset)     the engine REFUSES to drain an aged backlog and says so.
     *
     * Unset is safe rather than convenient, and that is the point: the failure
     * mode of guessing is paying real money to real people for trades nobody
     * intended to pay for, and it is not reversible by a code change.
     */
    IB_ACCRUAL_START: z
      .string()
      .refine(
        (value) => value === 'all' || !Number.isNaN(Date.parse(value)),
        'IB_ACCRUAL_START must be "all" or an ISO 8601 instant, e.g. "2026-08-24T00:00:00Z"',
      )
      .optional(),
    /*
     * `IB_DEAL_ACCRUAL_CRON` IS GONE (0114). Both halves of the commission
     * pipeline now read `ib_commission_interval_seconds` from the settings
     * form: leaving accrual on an environment variable meant an operator who
     * set "pay every minute" still waited however long a deploy-time value
     * said before a closed trade even became an accrual.
     */
    /*
     * How often the MT5 group catalogue is re-read. Hourly by default — the
     * thing it watches is a broker changing configuration during a working day,
     * so there is no burst to keep up with, and `GET /groups` costs ~4.9s on the
     * MT5 side.
     */
    /*
     * ── THE BRIDGE'S ADDRESS AND ITS TWO SECRETS ───────────────────────────
     *
     * Declared here because they were declared NOWHERE, and this file exists to
     * refuse boot on bad config. Nine `MT5_*` variables are read across the
     * codebase and exactly one of them was validated, so every way of getting
     * the bridge wrong produced a clean boot and a runtime that quietly does
     * less:
     *
     *   MT5_BRIDGE_URL missing   `Mt5BridgeClient.isConfigured` is false, so
     *                            every transfer is left PENDING for ever and
     *                            account creation has nothing to call. One warn
     *                            line per transfer, and nothing else.
     *   MT5_BRIDGE_SECRET missing
     *                            `BridgeSecretGuard` fails closed — correctly —
     *                            so every push is 401. The bridge treats 4xx on
     *                            a snapshot as permanent and DROPS it; deals
     *                            retry for ever and fill the outbox instead.
     *
     * Both of those are the "silent downgrade" the STORAGE_DRIVER block in this
     * same file refuses by name. A typo in a URL should not be the difference
     * between a working platform and one that stops moving money without
     * saying so.
     *
     * Optional in development, where a bridge often is not running and the
     * unconfigured path is a legitimate way to work. REQUIRED in production —
     * see PROD_REQUIRED.
     */
    /*
     * The SCHEME is checked explicitly, because `z.string().url()` is not
     * enough on its own: WHATWG parsing reads `bridge.internal:8443` as the
     * scheme `bridge.internal:` with path `8443`, so the most likely typo — a
     * host and port with the scheme left off — sails through `.url()` and fails
     * later inside `fetch`, hours after the deploy, as an unreadable parse
     * error in a log nobody is watching.
     */
    MT5_BRIDGE_URL: z
      .string()
      .url('MT5_BRIDGE_URL must be an absolute URL, e.g. https://bridge.internal:8443')
      .refine(
        (value) => /^https?:$/.test(new URL(value).protocol),
        'MT5_BRIDGE_URL must start with http:// or https:// — a bare host:port parses as a URL ' +
          'with a nonsense scheme and fails only when the first transfer tries to call it.',
      )
      .optional(),
    MT5_BRIDGE_API_KEY: z.string().min(1).optional(),
    /*
     * What the bridge presents in `X-Bridge-Secret`, compared in fixed time.
     * A length floor rather than a pattern: this is the only thing standing
     * between the open internet and an endpoint that writes deals to the
     * ledger, and a short shared secret is a guessable one.
     */
    MT5_BRIDGE_SECRET: z
      .string()
      .min(
        16,
        'MT5_BRIDGE_SECRET must be at least 16 characters — it is the only authentication on ' +
          'an endpoint that writes to the ledger.',
      )
      .optional(),
    MT5_BRIDGE_TIMEOUT_MS: z
      .string()
      .regex(/^\d+$/, 'MT5_BRIDGE_TIMEOUT_MS must be a whole number of milliseconds')
      .optional(),
    MT5_BRIDGE_READ_TIMEOUT_MS: z
      .string()
      .regex(/^\d+$/, 'MT5_BRIDGE_READ_TIMEOUT_MS must be a whole number of milliseconds')
      .optional(),
    /*
     * `MT5_GROUP_SYNC_CRON` (and the undeclared `TRANSFER_RESUME_CRON` /
     * `MT5_ACCOUNT_SYNC_CRON`) are NOT read any more (0167): every job's timing
     * is set in Settings → Scheduled jobs. Not re-declared, for the reason the
     * commission note above gives — a validated variable nothing reads says a
     * schedule is in force that is not.
     */

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
     * ── "Sign in with Google" for the ADMIN console (not the portal) ─────────
     *
     * OFF unless BOTH the id and the secret are set; one without the other
     * refuses boot (below). The secret authenticates this API to Google's token
     * endpoint — secrets manager only, and never logged: `redact.ts` masks any
     * key containing "secret", and nothing in the Google code prints it.
     *
     * GOOGLE_OAUTH_REDIRECT_URI defaults to
     * `<API_PUBLIC_URL>/v1/admin/auth/google/callback` and must be registered at
     * Google verbatim. GOOGLE_OAUTH_ALLOWED_DOMAINS (comma list) restricts it to
     * Workspace accounts of those domains — the `hd` claim AND the address.
     * The rules live in `config/google-oauth.ts`, shared with the runtime.
     */
    GOOGLE_OAUTH_CLIENT_ID: z.string().optional(),
    GOOGLE_OAUTH_CLIENT_SECRET: z.string().optional(),
    GOOGLE_OAUTH_REDIRECT_URI: z.string().optional(),
    GOOGLE_OAUTH_ALLOWED_DOMAINS: z.string().optional(),

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
     * ── The portal assistant (0187) ──────────────────────────────────────────
     *
     * Optional: without a key the assistant reads as unavailable everywhere,
     * whatever its admin switch says, and nothing else is affected. Use a key
     * from a DEDICATED OpenAI project with a monthly budget set in OpenAI's
     * dashboard. That budget is the backstop that holds even if every limit in
     * this codebase failed.
     *
     * `OPENAI_MODEL` defaults to `gpt-5.4-mini` (assistant/llm/openai.provider.ts).
     * Changing it changes what every answer costs and how it reads, so re-run
     * `npm run assistant:eval` after changing it.
     */
    // Empty is "not configured", like absent: the test config pins it empty so
    // no suite can ever reach OpenAI with a developer's real key.
    OPENAI_API_KEY: z.string().optional(),
    OPENAI_MODEL: z.string().min(1).optional(),

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
     * The D-11 commission backstops — validated HERE, at boot. (The deposit,
     * withdrawal and admin-credit limits lived here too until 0162 moved them
     * onto each currency, in its own units; `WITHDRAWAL_*` and
     * `ADMIN_CREDIT_MAX` are no longer read.)
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
    COMMISSION_MAX_PER_DEAL: decimalLimit('COMMISSION_MAX_PER_DEAL'),
    COMMISSION_MAX_SHARE_OF_DEAL: decimalLimit('COMMISSION_MAX_SHARE_OF_DEAL'),
  })
  .passthrough() // unknown keys pass through untouched
  .superRefine((env, ctx) => {
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

/*
 * THERE ARE NO SMTP_* VARIABLES AT ALL any more — not required, not optional,
 * not read. Do not add them back without reading smtp-config.service.ts.
 *
 * They were once required, for a good reason: mail was optional, `resolve()`
 * fell back to `smtp.example.com` with no auth, and `EmailService.send` catches
 * and logs rather than throwing — so a deploy missing SMTP started cleanly and
 * every verification link, KYC decision and withdrawal notification failed
 * silently.
 *
 * They are gone entirely because SMTP is ADMIN-CONFIGURED, on Settings → Email,
 * and the `smtp_settings` row (migration 0026) is what a real deployment uses.
 * Keeping an environment copy meant relay credentials in two places, with the
 * env half never used after the first save — and still able to be silently
 * fallen back to. DEPLOYMENT.md says it plainly: "There is no SMTP_* secret."
 *
 * The silent-failure hole is closed at its source: `SmtpConfigService.resolve()`
 * REFUSES when no row exists, rather than returning defaults that fail
 * downstream in a catch. That keeps R-8.5's "does not warn, does not degrade,
 * it refuses" while letting the process boot — which it must, because the screen
 * that configures mail is served by the process itself.
 */
const PROD_REQUIRED = [
  'DATABASE_URL',
  // Still required, and now MORE load-bearing than before: it seals
  // smtp_settings.password_ciphertext, so without it the settings screen cannot
  // store a relay password at all — and that screen is now the only way to
  // configure mail. The failure would land on an operator mid-form rather than
  // on the deploy that omitted it. Refuse, do not degrade.
  'APP_ENCRYPTION_KEY',
  /*
   * ── THE BRIDGE IS NOT OPTIONAL IN PRODUCTION ──────────────────────────────
   *
   * Without these the platform boots, serves every screen, and cannot move a
   * single unit of money to or from MT5: transfers sit `pending` for ever,
   * account creation has nothing to call, and every pushed snapshot is answered
   * 401 and dropped by a bridge that treats 4xx as permanent.
   *
   * That is a worse failure than not starting, because it is indistinguishable
   * from a quiet trading day. `STORAGE_DRIVER` in this same file refuses the
   * identical shape of mistake — "use R2 if configured, else disk" — for the
   * identical reason: one typo, no error, and the consequence found weeks later.
   *
   * Development is deliberately exempt. Running the CRM without a bridge is a
   * normal way to work on everything that is not trading, and
   * `TransferExecutor` has a documented, tested path for it.
   */
  'MT5_BRIDGE_URL',
  'MT5_BRIDGE_API_KEY',
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

  /*
   * Google sign-in: all of it or none of it, in every environment. A secret
   * with no id (or the reverse) is a half-finished edit, and a deployment that
   * starts with it would hide the Google button and say nothing about why.
   */
  const google = resolveGoogleOauth(env);
  if (google.status === 'invalid') {
    throw new Error(`Refusing to start: ${google.problem}`);
  }

  if (env.NODE_ENV === 'production') {
    /*
     * The Google callback carries an authorization code, and the flow cookie
     * that proves the browser started the flow. Over plain http both travel in
     * the clear — the same reasoning as ADMIN_URL below.
     */
    if (google.status === 'enabled' && !google.settings.redirectUri.startsWith('https://')) {
      throw new Error(
        'Refusing to start in production with a non-HTTPS Google redirect URI ' +
          `("${google.settings.redirectUri}"). The callback carries the authorization code and ` +
          'the signed flow cookie; set GOOGLE_OAUTH_REDIRECT_URI (or API_PUBLIC_URL) to https.',
      );
    }

    /*
     * A reset link in a log file is a takeover waiting to happen, and log
     * aggregation copies it somewhere with a different audience. Refusing to
     * START is the right severity: the alternative is a flag somebody sets to
     * debug a staging issue and never unsets.
     */
    if (env.LOG_EMAIL_LINKS) {
      throw new Error(
        'Refusing to start in production with LOG_EMAIL_LINKS enabled. It prints verification ' +
          'and password-reset links — each of which IS a credential — into the log. It exists ' +
          'for local testing against mailboxes that do not receive mail.',
      );
    }

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
    /*
     * The rate limits ARE the control on credential stuffing and token guessing
     * (§8.4). A production process that relaxed its own counter would be
     * unprotected while every dashboard still showed a limiter attached.
     */
    if (env.RELAX_RATE_LIMITS) {
      throw new Error(
        'Refusing to start in production with RELAX_RATE_LIMITS set. It exists so an ' +
          'end-to-end run does not spend minutes sleeping on login caps, and it makes the ' +
          'rate-limit counter permissive — which in production removes the §8.4 control on ' +
          'credential stuffing and token guessing while leaving a limiter apparently attached.',
      );
    }

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
