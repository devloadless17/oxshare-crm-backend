import { NestFactory } from '@nestjs/core';
import { ValidationPipe } from '@nestjs/common';
import { SwaggerModule } from '@nestjs/swagger';
import { ErrorResponseDto } from './common/dto/error-response.dto';
import { NestExpressApplication } from '@nestjs/platform-express';
import { AppModule } from './app.module';
import { VALIDATION_PIPE_OPTIONS } from './common/validation.config';
import { buildSwaggerConfig } from './common/swagger-config';
import { applyApiPrefix, createHttpAdapter } from './common/api-prefix';
import { Logger } from '@nestjs/common';
import { ALERT_KINDS, raiseAlert } from './common/logging/alerts';
import { JsonLogger } from './common/logging/json.logger';
import { RealtimeIoAdapter, type RealtimeEngine } from './common/realtime/realtime-io.adapter';
import { trustedProxyHops } from './common/security/client-ip';
import cookieParser from 'cookie-parser';
import helmet from 'helmet';
import { join } from 'path';
import { mkdirSync } from 'fs';

async function bootstrap() {
  // Ensure uploads directory exists
  mkdirSync(join(process.cwd(), 'uploads', 'kyc'), { recursive: true });

  // rawBody: signed webhooks verify an HMAC over the exact bytes
  // received — re-serializing the parsed body would change them.
  // createHttpAdapter(): case-sensitive routing, applied at instance creation
  // because Express reads that setting when it lazily builds its router on the
  // first `app.use()` — setting it below `helmet` is a silent no-op. See
  // common/api-prefix.ts for the bypass this closes.
  const app = await NestFactory.create<NestExpressApplication>(AppModule, createHttpAdapter(), {
    rawBody: true,
    // JSON lines carrying the correlation id in production; readable text in
    // development.
    logger: new JsonLogger(),
  });

  // KYC uploads are PII — served only via the authenticated UploadsController
  // (compliance module), never as anonymous static assets.

  // Security headers. Absent entirely before — and directly relevant here
  // because KYC documents are served from this origin (nosniff stops a
  // mislabelled upload being interpreted as HTML).
  app.use(
    helmet({
      contentSecurityPolicy: {
        directives: { defaultSrc: ["'self'"], frameAncestors: ["'none'"] },
      },
      crossOriginResourcePolicy: { policy: 'same-site' },
    }),
  );

  /*
   * The trust boundary for every security control that reads an IP — the rate
   * limiter, RBAC-08's allowlist, and the audit trail.
   *
   * Behind nginx or a load balancer an untuned `req.ip` is the PROXY's address,
   * so the limiter throttles the world as one caller and the allowlist admits
   * everyone or no-one. Trusting X-Forwarded-For blindly is worse: the caller
   * then chooses their own address. TRUSTED_PROXY_HOPS says how many proxies WE
   * operate, and Express counts that many entries in from the right — the ones
   * our own infrastructure wrote. See common/security/client-ip.ts.
   */
  app.set('trust proxy', trustedProxyHops());

  /*
   * ONE SETTING, THREE CONTROLS — say so at boot, because getting it wrong is
   * silent and the symptom appears somewhere else entirely.
   *
   * `TRUSTED_PROXY_HOPS` decides which entry of `X-Forwarded-For` is believed,
   * and THREE things key on the answer: the RBAC-08 network allowlist, the
   * per-IP rate limiter, and the audit trail. Set it too low and all three read
   * the proxy's address — one allowlist rule admits the world, the limiter
   * throttles every caller as one, and every audit row names the load balancer.
   * Set it too high and the caller picks their own address.
   *
   * The likeliest way it goes wrong is not a typo: it is putting a CDN in front
   * of a domain that already had one proxy, and not knowing this variable
   * exists. So the number is stated on every boot, next to what depends on it,
   * and a production deploy claiming ZERO proxies is called out — that is the
   * default, and a public API with no proxy in front of it is rare enough to be
   * worth a second look.
   */
  const bootLogger = new Logger('Bootstrap');
  const hops = trustedProxyHops();
  const proxyNote =
    `TRUSTED_PROXY_HOPS=${hops} — the IP allowlist (RBAC-08), the rate limiter and the ` +
    'audit trail all read the caller address through this. Raise it by one for each ' +
    'reverse proxy or CDN you put in front.';
  if (hops === 0 && process.env['NODE_ENV'] === 'production') {
    bootLogger.warn(
      `${proxyNote} It is 0 in production, so the SOCKET address is used and any ` +
        'X-Forwarded-For is ignored. Correct only if this process is exposed directly.',
    );
  } else {
    bootLogger.log(proxyNote);
  }

  app.use(cookieParser());

  // Global validation pipe. Options live in common/validation.config.ts so that
  // test/validation.spec.ts asserts against the same source rather than its own copy.
  app.useGlobalPipes(new ValidationPipe(VALIDATION_PIPE_OPTIONS));

  // CORS — allow portal (3000) and admin (3002)
  app.enableCors({
    origin: [
      process.env['PORTAL_URL'] ?? 'http://localhost:3000',
      process.env['ADMIN_URL'] ?? 'http://localhost:3002',
    ],
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    // X-Request-Id: both frontends generate a correlation id per request
    // (PLATFORM-CONVENTIONS R-6.1). Today they reach us through their own-origin
    // /api rewrite, so no preflight happens and this list is not consulted —
    // which is exactly why it has to be right BEFORE anything calls the API
    // cross-origin, or the header is silently dropped and the chain breaks with
    // no error anywhere.
    // X-OxShare-CSRF: the anti-forgery header (R-3.6). A header missing from
    // this list is stripped by the browser with no error anywhere — the request
    // simply arrives without it and fails the CSRF check for a reason nothing
    // logs.
    // Authorization is deliberately NOT here: the session is a cookie on both
    // surfaces and nothing reads a bearer token any more (R-3.1/R-3.2). Leaving
    // it listed advertised a second credential channel that no longer exists.
    // Idempotency-Key: R-5.2, required by the money-moving endpoints.
    // If-Match: the KYC builder names the version of the form it edited, so a
    // save over somebody else's newer change is refused (KYC_CONFIG_STALE).
    allowedHeaders: [
      'Content-Type',
      'X-Request-Id',
      'X-OxShare-CSRF',
      'Idempotency-Key',
      'If-Match',
    ],
    // So a caller can read the id back off a response it did not set one on.
    //
    // X-OxShare-CSRF is exposed for a load-bearing reason, not for symmetry with
    // the request header above: the frontends run on a different HOST from this
    // API, so `document.cookie` cannot reach the anti-forgery cookie and the
    // response header is the ONLY way they can learn the token. A header absent
    // from this list is withheld from JS by the browser with no error anywhere —
    // the read simply returns undefined and every write fails a CSRF check for a
    // reason nothing logs. See common/security/session-cookies.ts.
    //
    // ETag: the KYC form's version, read by the builder and sent back as
    // If-Match. Withheld, the builder would silently save without the check.
    exposedHeaders: ['X-Request-Id', 'X-OxShare-CSRF', 'ETag'],
  });

  /*
   * Every route is versioned: /v1/... — PLATFORM-CONVENTIONS R-2.1.
   *
   * THE CONFLICT THIS RESOLVES, stated so nobody re-litigates it by accident:
   *
   *   R-2.1 requires a version prefix from day one. The root CLAUDE.md said
   *   "Never reintroduce /v1 into a frontend base URL", and a test in
   *   openapi-routes.spec.ts enforced the absence. That instruction came from a
   *   real incident — the frontends called /api/v1/... against a backend serving
   *   bare paths and every request 404'd — so it was a correct BUG FIX that had
   *   hardened into an architectural position it was never meant to be.
   *
   * Both are satisfied here, because the disagreement was about WHERE the
   * prefix lives. The frontends' axios `baseURL` stays `/api` and no application
   * code changes; only each app's next.config.ts rewrite destination gains the
   * segment. So "never in a frontend base URL" stays literally true, and the API
   * gains the version.
   *
   * Doing it now is the whole point: an unversioned API has one shape forever or
   * breaks its callers silently, and today there are exactly zero external
   * consumers. The payment providers have no
   * credentials (§12.5), and no mobile client is built. The moment any of them
   * holds a URL this stops being a rewrite rule and becomes a coordinated
   * migration with third parties.
   *
   * /health is excluded. Load balancers and uptime checks should not have to
   * track API versions to ask whether the process is alive, and a readiness
   * probe that 404s during a version migration is an outage caused by the
   * monitoring.
   */
  applyApiPrefix(app);

  /*
   * Swagger at /api/docs — NEVER in production.
   *
   * This was mounted unconditionally, so a production deploy published the
   * complete route inventory, every DTO and every permission name to anyone who
   * asked. That is not a vulnerability by itself; it hands an attacker the whole
   * attack surface for free, including the admin routes, and there is no reason
   * for it to be reachable from the internet.
   *
   * Gating it costs nothing operationally: both frontends generate their types
   * from /api/docs-json against a LOCAL backend (`npm run gen:api-types`, see
   * docs/API-CONTRACTS.md Part C), which is a development activity by
   * definition. The seeds directly below have been gated this way all along —
   * this is the same reasoning applied to the same kind of convenience.
   */
  if (process.env['NODE_ENV'] !== 'production') {
    // Built from common/swagger-config.ts, which the contract generator and the
    // route-inventory test also read — so the served document and the committed
    // openapi.json cannot describe different credentials again.
    const config = buildSwaggerConfig();
    // `extraModels` because no handler RETURNS this shape — AllExceptionsFilter
    // emits it. Without it the envelope reaches no frontend's generated types, and
    // both apps hand-write their own picture of it (R-1.1/R-2.2).
    const document = SwaggerModule.createDocument(app, config, {
      extraModels: [ErrorResponseDto],
    });
    SwaggerModule.setup('api/docs', app, document);
  }

  // Seeds create a known-password master admin. That is a development
  // convenience and a production compromise, so it never runs in production.
  if (process.env['NODE_ENV'] !== 'production') {
    const { runSeeds } = await import('./database/seed');
    await runSeeds();
  }

  // Bring the `Administrator` role up to config/permissions.json — the top-level
  // role in the system, so the catalog is its definition. It ADDS only, touches
  // no other role, and names every key it grants. Deliberately OUTSIDE the guard
  // above: the seed is what keeps development in step, so production is the
  // environment where this drifts, and it is where four of these gaps were found
  // by a person hitting a 403 in a browser. See database/permission-drift.ts.
  const { reportPermissionDrift } = await import('./database/permission-drift');
  await reportPermissionDrift();

  /*
   * The realtime engine, chosen before listen so the gateway is created on it.
   *
   * Nest builds the Socket.IO server the first time a gateway initialises, so
   * this must be installed BEFORE `app.listen` — registering the adapter after
   * would leave the gateway on the default engine while every log line claimed
   * otherwise.
   */
  const realtimePort = Number(process.env['REALTIME_PORT'] ?? 3003);
  const realtimeAdapter = new RealtimeIoAdapter(
    app,
    (process.env['REALTIME_ENGINE'] as RealtimeEngine) ?? 'uws',
    realtimePort,
  );
  app.useWebSocketAdapter(realtimeAdapter);

  /*
   * SIGTERM must drain, not kill. Node's default action for a signal with no
   * listener is IMMEDIATE termination, so without this every `docker compose up
   * -d` recreate — i.e. every deploy — severed in-flight requests mid-flight.
   * On a system whose wallet writes hold `SELECT ... FOR UPDATE` for the length
   * of a transaction, that means the caller gets a dropped connection instead of
   * an idempotent answer, and has no way to learn which of the two happened.
   * Postgres rolls the transaction back, so no money is lost — but a deposit
   * whose outcome is unknown to its caller is a support incident either way.
   *
   * `stop_grace_period` in compose is what gives this time to finish; it was
   * doing nothing at all while the process exited on the signal instead of
   * handling it. Enabling hooks is also what makes OnApplicationShutdown fire,
   * which is how the pg pool and the realtime LISTEN connection get closed —
   * see DatabaseModule.
   */
  app.enableShutdownHooks();

  const port = process.env['PORT'] ?? 3001;
  await app.listen(port);

  console.log(`🚀 API running on        http://localhost:${port}`);
  if (process.env['NODE_ENV'] !== 'production') {
    console.log(`📚 Swagger docs at       http://localhost:${port}/api/docs`);
  }
  console.log(`❤️  Health check at      http://localhost:${port}/health`);
  /*
   * The socket's REAL port, asked of the adapter rather than assumed from
   * REALTIME_PORT. The two engines put it in different places — uws on its own
   * listener, node attached to the API server — and uws also degrades to node
   * where the native binary has no prebuild. Printed after `listen`, which is
   * when the gateway initialises and the engine is settled.
   *
   * The old line named REALTIME_PORT unconditionally, so it announced :3003
   * under the node engine and after every fallback: a port with nothing on it,
   * stated as fact, which is the most expensive kind of log line to trust.
   */
  const socketPort = realtimeAdapter.engineInUse === 'uws' ? realtimePort : port;
  console.log(`⚡ Realtime socket on    http://localhost:${socketPort}/realtime`);
}

/**
 * The two ways a Node process dies without anybody deciding it should.
 *
 * ## Why this is a SECURITY control and not an ergonomics one
 *
 * Neither handler is here to hide bugs. They are here because the failure they
 * cover is SILENT: a process that exits and is restarted by `restart:
 * unless-stopped` leaves no trace anywhere a person looks. The API comes back,
 * the health check goes green, and the only evidence is a gap in a log nobody
 * ships. An attacker who finds an input that reliably kills the process has a
 * denial of service that reports itself as uptime.
 *
 * The exposure is real rather than theoretical: there are ~40 deliberate
 * fire-and-forget calls in this codebase (`void this.notifications.notify(…)`,
 * `void this.email.send…`). Every one of them is correct — their callees catch
 * internally — but that is a promise made forty times by forty different
 * methods, and `void` silences the linter without silencing the runtime.
 *
 * ## The two are handled DIFFERENTLY, on purpose
 *
 * `unhandledRejection` → alert and CARRY ON. Every fire-and-forget site in this
 * system is a notification, an email or an audit row. Money paths are awaited
 * inside their transaction and cannot land here. Killing a money API because an
 * email bounced is a worse outcome than the bounce.
 *
 * `uncaughtException` → alert, then EXIT. A synchronous throw that reached the
 * top means the stack unwound through code that expected to finish; the process
 * state is genuinely unknown, and continuing risks acting on half-applied work.
 * Exiting hands the problem to the restart policy, which is the one component
 * designed for it. The alert is what turns a silent restart into a known event.
 */
process.on('unhandledRejection', (reason) => {
  raiseAlert(
    new Logger('Process'),
    ALERT_KINDS.UNHANDLED_REJECTION,
    'page',
    `An unhandled promise rejection reached the top of the process: ${
      reason instanceof Error ? reason.message : String(reason)
    }`,
    { stack: reason instanceof Error ? (reason.stack ?? '').slice(0, 500) : 'none' },
  );
});

process.on('uncaughtException', (error) => {
  raiseAlert(
    new Logger('Process'),
    ALERT_KINDS.UNCAUGHT_EXCEPTION,
    'page',
    `Uncaught exception — the process is exiting: ${error.message}`,
    { stack: (error.stack ?? '').slice(0, 500) },
  );
  // Give the alert sinks a moment to flush before the exit takes them with it.
  setTimeout(() => process.exit(1), 250).unref();
});

/*
 * A FAILED BOOT EXITS. It used to be `void bootstrap()`, which sent a startup
 * failure to the `unhandledRejection` handler above — whose policy, "alert and
 * carry on", is right for a bounced email and wrong for the server itself.
 *
 * What that produced, seen on 25 Sep: one query failed while a module was
 * initialising (`SelfServiceGroups.onModuleInit` reading trading products, only
 * to print which account types are open), `app.listen` was never reached, and
 * the process stayed alive holding nothing. `pgrep` saw a backend, :3001 had no
 * listener, and nothing restarted it — the console read "Cannot reach the
 * server" until somebody killed it by hand. In production the container would
 * sit "Up" serving nothing, and a restart policy never fires for a process that
 * does not exit.
 *
 * Exiting hands a failed boot to the restart policy, the same reasoning
 * `uncaughtException` states above — and a transient database blip at deploy
 * becomes a restart that succeeds instead of an outage that lasts.
 */
bootstrap().catch((error: unknown) => {
  raiseAlert(
    new Logger('Process'),
    ALERT_KINDS.UNCAUGHT_EXCEPTION,
    'page',
    `The API failed to start and is exiting: ${error instanceof Error ? error.message : String(error)}`,
    { stack: error instanceof Error ? (error.stack ?? '').slice(0, 500) : 'none' },
  );
  // The code is set FIRST: if the event loop drains before the timer fires, the
  // process ends on its own — and must not end with 0, which an `on-failure`
  // restart policy reads as a clean stop.
  process.exitCode = 1;
  setTimeout(() => process.exit(1), 250).unref();
});
