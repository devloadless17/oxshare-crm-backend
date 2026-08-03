import { NestFactory } from '@nestjs/core';
import { ValidationPipe } from '@nestjs/common';
import { SwaggerModule, DocumentBuilder } from '@nestjs/swagger';
import { NestExpressApplication } from '@nestjs/platform-express';
import { AppModule } from './app.module';
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

  // Global validation pipe — whitelist & transform DTOs
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: false,
      transform: true,
    }),
  );

  // CORS — allow portal (3000) and admin (3002)
  app.enableCors({
    origin: [
      process.env['PORTAL_URL'] ?? 'http://localhost:3000',
      process.env['ADMIN_URL'] ?? 'http://localhost:3002',
    ],
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization'],
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
