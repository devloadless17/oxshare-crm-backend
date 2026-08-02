import { NestFactory } from '@nestjs/core';
import { ValidationPipe, VersioningType } from '@nestjs/common';
import { SwaggerModule, DocumentBuilder } from '@nestjs/swagger';
import { NestExpressApplication } from '@nestjs/platform-express';
import { AppModule } from './app.module';
import * as cookieParser from 'cookie-parser';
import { join } from 'path';
import { mkdirSync } from 'fs';

async function bootstrap() {
  // Ensure uploads directory exists
  mkdirSync(join(process.cwd(), 'uploads', 'kyc'), { recursive: true });

  const app = await NestFactory.create<NestExpressApplication>(AppModule);

  // Serve uploaded KYC files (admin only — add auth middleware in production)
  app.useStaticAssets(join(process.cwd(), 'uploads'), { prefix: '/uploads' });

  // Cookie parser (needed for httpOnly JWT cookies)
  app.use(cookieParser());

  // Global validation pipe — whitelist & transform DTOs
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  );

  // URI versioning — default version v1
  app.enableVersioning({
    type: VersioningType.URI,
    defaultVersion: '1',
  });

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

  const port = process.env['PORT'] ?? 3001;
  await app.listen(port);

  console.log(`🚀 API running on        http://localhost:${port}`);
  console.log(`📚 Swagger docs at       http://localhost:${port}/api/docs`);
  console.log(`❤️  Health check at      http://localhost:${port}/v1/health`);
}

bootstrap();
