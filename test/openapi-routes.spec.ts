import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { Test } from '@nestjs/testing';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import type { INestApplication } from '@nestjs/common';
import { AppModule } from '../src/app.module';

/**
 * The route inventory is frozen against a committed fixture.
 *
 * This exists to make two otherwise-risky refactors safe:
 *   1. moving request DTOs out of controllers into dto/ files, and
 *   2. splitting a single fat controller into several sharing one @Controller prefix.
 *
 * Both are supposed to change zero routes. Without this test they are silent
 * 404 generators — a typo'd path or a controller left out of `controllers:` is
 * invisible until a frontend call fails, and both frontends read these paths
 * through generated types that would regenerate happily around the mistake.
 *
 * It boots the real AppModule, so it also catches a DI wiring break that
 * unit-instantiated specs sail straight past.
 *
 * No database is needed: getDb() builds its pool lazily and nothing queries
 * during module init. That is why this spec runs in milliseconds while the money
 * specs need Testcontainers.
 *
 * When you intend to change the API surface, run with UPDATE_ROUTE_SNAPSHOT=1 and
 * review the fixture diff as part of the change.
 */

const FIXTURE = join(__dirname, 'fixtures', 'openapi-routes.json');

const HTTP_METHODS = ['get', 'put', 'post', 'delete', 'patch', 'options', 'head'] as const;

let app: INestApplication;

beforeAll(async () => {
  // Match main.ts so the emitted document is the one the frontends generate from.
  process.env['NODE_ENV'] ??= 'test';

  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
  app = moduleRef.createNestApplication();
  await app.init();
}, 60_000);

afterAll(async () => {
  await app?.close();
});

function routeInventory(): string[] {
  const config = new DocumentBuilder()
    .setTitle('OxShare CRM API')
    .setVersion('1.0')
    .addBearerAuth()
    .addCookieAuth('access_token')
    .build();

  const document = SwaggerModule.createDocument(app, config);

  const routes: string[] = [];
  for (const [path, item] of Object.entries(document.paths ?? {})) {
    for (const method of HTTP_METHODS) {
      if (item && method in item) routes.push(`${method.toUpperCase()} ${path}`);
    }
  }
  return routes.sort();
}

describe('OpenAPI route inventory', () => {
  it('matches the committed fixture', () => {
    const actual = routeInventory();

    // Guard against the test passing vacuously if AppModule ever stops
    // registering controllers — an empty inventory must never look like a match.
    expect(actual.length).toBeGreaterThan(30);

    if (!existsSync(FIXTURE) || process.env['UPDATE_ROUTE_SNAPSHOT'] === '1') {
      writeFileSync(FIXTURE, `${JSON.stringify(actual, null, 2)}\n`);
      console.warn(`[openapi-routes] wrote fixture with ${actual.length} routes: ${FIXTURE}`);
      return;
    }

    const expected = JSON.parse(readFileSync(FIXTURE, 'utf8')) as string[];
    expect(actual).toEqual(expected);
  });

  it('exposes no route under a /api or /v1 prefix', () => {
    // main.ts calls neither setGlobalPrefix() nor enableVersioning(), so the
    // `version: '1'` on a few controllers is inert. Both frontends strip /api in
    // their rewrite and had to have a reintroduced /v1 removed once already.
    const offenders = routeInventory().filter((r) => / \/(api|v1)\b/.test(r));
    expect(offenders).toEqual([]);
  });
});
