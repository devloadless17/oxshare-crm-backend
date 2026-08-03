import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import { AppModule } from '../src/app.module';
import { WalletService } from '../src/modules/wallet/wallet.service';
import { TransactionsService } from '../src/modules/payments/transactions.service';
import { CommissionService } from '../src/modules/partners/commission.service';
import { ProgramsService } from '../src/modules/partners/programs.service';

/**
 * The money services now declare their database dependency instead of reaching
 * for the module-level `getDb()` singleton.
 *
 * The four §11 money specs construct these services by hand (`new
 * WalletService(getDb())`) because they need a Testcontainers Postgres, so they
 * would keep passing even if the Nest DI graph were broken — a missing provider
 * or an unexported DatabaseModule would only surface as a boot failure in
 * production. This spec closes that gap by resolving each service from the real
 * AppModule.
 *
 * No database is required: DRIZZLE_DB's factory builds the pool lazily and
 * nothing queries during module init.
 */

let app: INestApplication;

beforeAll(async () => {
  process.env['NODE_ENV'] ??= 'test';
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
  app = moduleRef.createNestApplication();
  await app.init();
}, 60_000);

afterAll(async () => {
  await app?.close();
});

describe('money service DI wiring', () => {
  it.each([
    ['WalletService', WalletService],
    ['TransactionsService', TransactionsService],
    ['CommissionService', CommissionService],
    ['ProgramsService', ProgramsService],
  ])('resolves %s from the real module graph with its db injected', (_name, token) => {
    // `db` is private, so it is read through an index rather than asserted onto a
    // shape the compiler already knows.
    const service: Record<string, unknown> = app.get(token);
    expect(service).toBeDefined();
    // The injected handle must actually be present — a service resolved with an
    // undefined db would fail on first use, at runtime, on a money path.
    expect(service['db']).toBeDefined();
  });
});
