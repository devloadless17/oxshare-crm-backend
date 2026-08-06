import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { Test } from '@nestjs/testing';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { AppModule } from '../src/app.module';
import { applyApiPrefix, createHttpAdapter } from '../src/common/api-prefix';

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

let app: NestExpressApplication;

beforeAll(async () => {
  // Match main.ts so the emitted document is the one the frontends generate from.
  process.env['NODE_ENV'] ??= 'test';

  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
  // The SAME adapter and the SAME prefix call main.ts makes, from the same
  // module — otherwise this snapshot describes a surface the server does not
  // serve, and the frontends generate their types from a document that
  // disagrees with reality. `createHttpAdapter()` carries the case-sensitive
  // routing that makes `/v1/Admin/...` a 404 rather than a second, unguarded
  // spelling of every admin route (common/api-prefix.ts).
  app = moduleRef.createNestApplication<NestExpressApplication>(createHttpAdapter());
  applyApiPrefix(app);
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

  it('serves EVERY route under /v1, except the health probes', () => {
    /*
     * The inverse of what this test asserted until R-2.1 landed.
     *
     * It used to enforce the absence of a version prefix, because the root
     * CLAUDE.md said "never reintroduce /v1" after a real incident: the
     * frontends called /api/v1/... against a backend serving bare paths and
     * every request 404'd. That was a correct bug fix which had hardened into
     * an architectural position it was never meant to be.
     *
     * The disagreement was about WHERE the prefix lives. It lives on the API;
     * the frontends' axios baseURL is still `/api` and only their rewrite
     * destination carries the segment, so the original instruction stays
     * literally true.
     */
    const unversioned = routeInventory().filter((r) => !/ \/v1\//.test(r));
    expect(unversioned.sort()).toEqual(['GET /health', 'GET /health/ready']);
  });

  it('serves the health probes UNVERSIONED', () => {
    // A load balancer should not have to track API versions to ask whether the
    // process is alive, and a readiness probe that 404s mid-migration is an
    // outage caused by the monitoring.
    const inventory = routeInventory();
    expect(inventory).toContain('GET /health');
    expect(inventory).toContain('GET /health/ready');
  });
});
