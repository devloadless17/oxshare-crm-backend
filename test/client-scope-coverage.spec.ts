import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Test } from '@nestjs/testing';
import { DiscoveryService, MetadataScanner, Reflector } from '@nestjs/core';
import { PATH_METADATA, METHOD_METADATA, GUARDS_METADATA } from '@nestjs/common/constants';
import type { INestApplication } from '@nestjs/common';
import { RequestMethod } from '@nestjs/common';
import { AppModule } from '../src/app.module';
import {
  CLIENT_SCOPE_KEY,
  type ClientScopeStance,
} from '../src/modules/admin/guards/client-scope.decorator';

/**
 * Every admin route states whether it applies the CLIENT SCOPE.
 *
 * Deliberately built the same way as `route-authorization.spec.ts`, because it
 * is the same problem in a second dimension. A scope predicate only runs where
 * somebody remembered to pass the actor's scope, and a route that forgot looks
 * exactly like a route that never needed one — both are just a handler. No
 * reviewer reliably tells them apart in a diff, and missing it once shows a
 * scoped administrator client data they were specifically denied, with nothing
 * failing anywhere.
 *
 * So the rule is inverted: every route below must MAKE A STATEMENT —
 * `@ScopedToClients(...)` naming where the predicate goes, or
 * `@NotClientScoped(...)` saying why there is nothing to scope. A new endpoint
 * with neither fails this test, which fails CI.
 *
 * This file only checks that the statement EXISTS. Whether a route that claims
 * to be scoped actually is, is `client-scope-enforcement.spec.ts` — which
 * derives its inputs from this same metadata, so a route cannot join the
 * "declared scoped" set without also being exercised against a real
 * out-of-scope client.
 */

let app: INestApplication;
let discovery: DiscoveryService;
let reflector: Reflector;

const METHOD_NAMES: Record<number, string> = {
  [RequestMethod.GET]: 'GET',
  [RequestMethod.POST]: 'POST',
  [RequestMethod.PUT]: 'PUT',
  [RequestMethod.DELETE]: 'DELETE',
  [RequestMethod.PATCH]: 'PATCH',
  [RequestMethod.OPTIONS]: 'OPTIONS',
  [RequestMethod.HEAD]: 'HEAD',
  [RequestMethod.ALL]: 'ALL',
};

interface ScopeFacts {
  signature: string;
  stance?: ClientScopeStance;
  guards: string[];
}

beforeAll(async () => {
  process.env['NODE_ENV'] ??= 'test';
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
  app = moduleRef.createNestApplication();
  await app.init();
  discovery = app.get(DiscoveryService);
  reflector = app.get(Reflector);
}, 60_000);

afterAll(async () => {
  await app?.close();
});

const normalise = (p: string) => (p === '/' || p === '' ? '' : `/${p.replace(/^\/|\/$/g, '')}`);
const joinPath = (prefix: string, path: string) => `${prefix}${path}` || '/';

function pathsOf(raw: unknown): string[] {
  if (typeof raw === 'string') return [normalise(raw)];
  if (Array.isArray(raw)) return raw.flatMap((entry) => pathsOf(entry));
  if (raw && typeof raw === 'object' && 'path' in raw) return pathsOf(raw.path);
  return [''];
}

const nameOf = (guard: unknown): string => {
  if (typeof guard === 'function') return guard.name;
  if (guard && typeof guard === 'object') return guard.constructor.name;
  return String(guard);
};

/** Every route, with the scope stance it declares. */
export function scopeFacts(): ScopeFacts[] {
  const scanner = new MetadataScanner();
  const found: ScopeFacts[] = [];

  for (const wrapper of discovery.getControllers()) {
    const instance = wrapper.instance as Record<string, unknown> | undefined;
    const controllerClass = wrapper.metatype as (new (...args: never[]) => unknown) | undefined;
    if (!instance || !controllerClass) continue;

    const prefixes = pathsOf(Reflect.getMetadata(PATH_METADATA, controllerClass));
    const classGuards = (Reflect.getMetadata(GUARDS_METADATA, controllerClass) ?? []) as unknown[];
    const prototype = Object.getPrototypeOf(instance) as object;

    for (const methodName of scanner.getAllMethodNames(prototype)) {
      const handler = instance[methodName] as ((...args: never[]) => unknown) | undefined;
      if (!handler) continue;
      const raw = Reflect.getMetadata(PATH_METADATA, handler) as unknown;
      if (raw === undefined) continue;

      const method = Reflect.getMetadata(METHOD_METADATA, handler) as number;
      const handlerGuards = (Reflect.getMetadata(GUARDS_METADATA, handler) ?? []) as unknown[];

      for (const prefix of prefixes) {
        for (const path of pathsOf(raw)) {
          found.push({
            signature: `${METHOD_NAMES[method]} ${joinPath(prefix, path)}`,
            stance: reflector.get<ClientScopeStance>(CLIENT_SCOPE_KEY, handler),
            guards: [...classGuards, ...handlerGuards].map(nameOf),
          });
        }
      }
    }
  }
  return found;
}

/**
 * The routes this rule governs: the admin surface, plus the one client-PII
 * route that lives outside it.
 *
 * `/uploads/kyc/:file` is deliberately in scope despite its prefix — it serves
 * a client's passport to an administrator, which is exactly the kind of read
 * this feature exists to restrict, and its path would otherwise exempt it.
 */
const GOVERNED = (signature: string) =>
  signature.includes(' /admin') || signature.includes(' /uploads');

describe('every admin route declares a client-scope stance', () => {
  it('sees EVERY route the OpenAPI document sees', () => {
    /*
     * The load-bearing check, and the reason it is first.
     *
     * Every assertion below is "no route has problem X". A scan that silently
     * misses a controller reports a clean bill of health for routes it never
     * looked at — the most dangerous possible failure for a test whose whole
     * job is to notice an unscoped endpoint. Cross-checking against the
     * committed OpenAPI fixture, produced by Nest's own Swagger scanner rather
     * than by this file's reflection, means a disagreement says so out loud.
     */
    const fixture = JSON.parse(
      readFileSync(join(__dirname, 'fixtures', 'openapi-routes.json'), 'utf8'),
    ) as string[];

    // The fixture is OpenAPI-shaped (`{id}`, `/v1/` prefix); this scan reads
    // Nest's own metadata (`:id`, no global prefix). Normalised the same way
    // `route-authorization.spec.ts` does, so the two specs agree about what a
    // route is called.
    const scanned = new Set(scopeFacts().map((r) => r.signature));
    const missed = fixture
      .map((route) => route.replace(/\{(\w+)\}/g, ':$1').replace(/ \/v1\//, ' /'))
      .filter((sig) => !scanned.has(sig));

    expect(
      missed,
      `This scan did not see these routes, so any conclusion it draws about them is ` +
        `worthless:\n${missed.map((m) => `  ${m}`).join('\n')}`,
    ).toEqual([]);
  });

  it('leaves no governed route without a stance', () => {
    const undeclared = scopeFacts()
      .filter((r) => GOVERNED(r.signature))
      .filter((r) => !r.stance)
      .map((r) => r.signature);

    expect(
      undeclared,
      'These routes are on the admin surface and say nothing about client scoping. ' +
        'Add @ScopedToClients("where the predicate goes") if they read client-owned ' +
        'rows, or @NotClientScoped("why there is nothing to scope") if they do ' +
        `not:\n${undeclared.map((m) => `  ${m}`).join('\n')}`,
    ).toEqual([]);
  });

  it('requires a real sentence on every exemption', () => {
    /*
     * The same rule PUBLIC_ROUTES uses, for the same reason: an exemption list
     * with "n/a" in it is an exemption list nobody reviews. A reason long
     * enough to be a sentence is one somebody had to think about.
     */
    const thin = scopeFacts()
      .filter((r) => GOVERNED(r.signature) && r.stance?.stance === 'none')
      .filter((r) => (r.stance?.note.length ?? 0) < 30)
      .map((r) => `${r.signature} — "${r.stance?.note ?? ''}"`);

    expect(thin, `These exemptions do not explain themselves:\n${thin.join('\n')}`).toEqual([]);
  });

  it('requires a scoped route to say WHERE the predicate goes', () => {
    // "This is scoped" is a claim. Naming the store method and the column is
    // what lets a reviewer check it without reading the whole service.
    const vague = scopeFacts()
      .filter((r) => r.stance?.stance === 'scoped')
      .filter((r) => (r.stance?.note.length ?? 0) < 30)
      .map((r) => r.signature);

    expect(vague, `These claim to be scoped without saying how:\n${vague.join('\n')}`).toEqual([]);
  });

  it('finds a meaningful number of scoped routes, so it cannot pass vacuously', () => {
    // The R-4.2 lesson again: if the reflection breaks, every "no route has
    // problem X" assertion above passes by examining nothing.
    const scoped = scopeFacts().filter((r) => r.stance?.stance === 'scoped');
    expect(scoped.length).toBeGreaterThanOrEqual(10);
  });

  /**
   * Two routes are exempt on the grounds that only a master admin reaches them,
   * and a master admin is unrestricted by definition. That reasoning holds ONLY
   * while the guard does — so the guard is asserted here rather than trusted.
   *
   * Without this, opening either route to sub-admins later would be a one-line
   * change that silently serves unscoped client subjects, and the exemption note
   * would still read as though it had been thought about.
   */
  it('keeps MasterAdminGuard on the routes whose exemption depends on it', () => {
    const masterOnly = ['GET /admin/audit-log'];
    const facts = scopeFacts();

    for (const signature of masterOnly) {
      const route = facts.find((r) => r.signature === signature);
      expect(route, `${signature} is gone — update this list or restore the route`).toBeDefined();
      expect(
        route?.guards,
        `${signature} is exempt from client scoping ONLY because a master admin is ` +
          'unrestricted. It no longer carries MasterAdminGuard, so that reasoning has ' +
          'stopped being true and the route now needs a real scope.',
      ).toContain('MasterAdminGuard');
    }
  });
});
