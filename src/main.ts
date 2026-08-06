import { NestFactory } from '@nestjs/core';
import { ValidationPipe } from '@nestjs/common';
import { SwaggerModule } from '@nestjs/swagger';
import { ErrorResponseDto } from './common/dto/error-response.dto';
import { NestExpressApplication } from '@nestjs/platform-express';
import { AppModule } from './app.module';
import { VALIDATION_PIPE_OPTIONS } from './common/validation.config';
import { buildSwaggerConfig } from './common/swagger-config';
import { applyApiPrefix, createHttpAdapter } from './common/api-prefix';
import { JsonLogger } from './common/logging/json.logger';
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
    allowedHeaders: ['Content-Type', 'X-Request-Id', 'X-OxShare-CSRF', 'Idempotency-Key'],
    // So a caller can read the id back off a response it did not set one on.
    exposedHeaders: ['X-Request-Id'],
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

    /*
     * Separate from `runSeeds` because it writes MONEY, and money is only ever
     * written through `WalletService` (§6.2) — which `database/` may not import,
     * since modules depend on database and never the reverse. Called second
     * because it needs the demo client `runSeeds` creates.
     */
    const { seedDemoTradingData } = await import('./modules/trading/demo-trading-seed');
    await seedDemoTradingData();
  }

  const port = process.env['PORT'] ?? 3001;
  await app.listen(port);

  console.log(`🚀 API running on        http://localhost:${port}`);
  if (process.env['NODE_ENV'] !== 'production') {
    console.log(`📚 Swagger docs at       http://localhost:${port}/api/docs`);
  }
  console.log(`❤️  Health check at      http://localhost:${port}/health`);
}

void bootstrap();
