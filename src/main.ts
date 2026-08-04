import { NestFactory } from '@nestjs/core';
import { ValidationPipe } from '@nestjs/common';
import { SwaggerModule, DocumentBuilder } from '@nestjs/swagger';
import { NestExpressApplication } from '@nestjs/platform-express';
import { AppModule } from './app.module';
import { VALIDATION_PIPE_OPTIONS } from './common/validation.config';
import { JsonLogger } from './common/logging/json.logger';
import cookieParser from 'cookie-parser';
import helmet from 'helmet';
import { join } from 'path';
import { mkdirSync } from 'fs';

async function bootstrap() {
  // Ensure uploads directory exists
  mkdirSync(join(process.cwd(), 'uploads', 'kyc'), { recursive: true });

  // rawBody: the MT5 bridge webhook verifies an HMAC over the exact bytes
  // received — re-serializing the parsed body would change them.
  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
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
    allowedHeaders: ['Content-Type', 'Authorization', 'X-Request-Id', 'X-OxShare-CSRF'],
    // So a caller can read the id back off a response it did not set one on.
    exposedHeaders: ['X-Request-Id'],
  });

  // Swagger docs (available at /api/docs)
  const config = new DocumentBuilder()
    .setTitle('OxShare CRM API')
    .setDescription('Forex/CFD Introducing-Broker CRM — Phase 1')
    .setVersion('1.0')
    .addBearerAuth()
    .addCookieAuth('access_token')
    .addTag('identity', 'Users, registration, attribution')
    .addTag('trading', 'MT5 accounts, groups, deal ingestion')
    .addTag('wallet', 'Balances, ledger, transactions')
    .addTag('payments', 'Deposits, withdrawals, Whish/USDT')
    .addTag('partners', 'IB programs, commission engine, payouts')
    .addTag('compliance', 'KYC documents, verification levels')
    .addTag('admin', 'Back-office endpoints, RBAC')
    .build();
  const document = SwaggerModule.createDocument(app, config);
  SwaggerModule.setup('api/docs', app, document);

  // Seeds create a known-password master admin. That is a development
  // convenience and a production compromise, so it never runs in production.
  if (process.env['NODE_ENV'] !== 'production') {
    const { runSeeds } = await import('./database/seed');
    await runSeeds();
  }

  const port = process.env['PORT'] ?? 3001;
  await app.listen(port);

  console.log(`🚀 API running on        http://localhost:${port}`);
  console.log(`📚 Swagger docs at       http://localhost:${port}/api/docs`);
  console.log(`❤️  Health check at      http://localhost:${port}/health`);
}

void bootstrap();
