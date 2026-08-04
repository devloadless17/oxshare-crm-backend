import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Test } from '@nestjs/testing';
import { DiscoveryService, MetadataScanner, Reflector } from '@nestjs/core';
import { PATH_METADATA, METHOD_METADATA, GUARDS_METADATA } from '@nestjs/common/constants';
import type { INestApplication } from '@nestjs/common';
import { RequestMethod } from '@nestjs/common';
import { AppModule } from '../src/app.module';
import { ANY_ADMIN_KEY, PERMISSIONS_KEY } from '../src/modules/admin/guards/admin.guard';
import { NO_CSRF_KEY } from '../src/common/security/csrf.guard';

/**
 * Every route declares how it is protected — PLATFORM-CONVENTIONS R-4.2.
 *
 * This is the enforcement, not the guards. A guard only runs where someone
 * remembered to attach it, and an endpoint that forgot one looks exactly like an
 * endpoint that never needed one: both are just a handler with no decorator. No
 * reviewer reliably spots the difference in a diff, and the consequence of
 * missing it once, on a money system, is an open door nobody knows about.
 *
 * So the rule is inverted here. Every route must make a statement — a guard, a
 * required permission, or an explicit entry in PUBLIC_ROUTES below saying why it
 * is deliberately open. A new endpoint with no statement fails this test, which
 * means it fails CI, which means the failure mode of forgetting is a red build
 * rather than a silent hole.
 *
 * It reads Nest's own metadata rather than scanning source text: a regex over
 * decorators cannot tell a guard eight lines above a handler from one attached
 * to a different handler, and would report both false hits and false misses.
 */

/**
 * Routes that are deliberately reachable without a session, each with the reason.
 *
 * Adding to this list is the decision. It should be rare, and it should read
 * like something someone chose.
 */
/**
 * Routes that authenticate INSIDE the handler rather than through a guard.
 *
 * A guard is the better shape, and anything added here should be a candidate for
 * conversion. Listed explicitly so "no guard" never silently means "no check".
 */
const HANDLER_AUTHENTICATED: Record<string, string> = {
  'GET /uploads/kyc/:file':
    'Serves a KYC document to a kyc.review admin OR to the client who owns it — two different ' +
    'identities on one route, so the check is inside the handler and is an OWNERSHIP check, not ' +
    'just a role one (R-4.4). Worth converting to a guard.',
};

const PUBLIC_ROUTES: Record<string, string> = {
  // Establishing a session cannot require one.
  'POST /admin/auth/login': 'Establishes the admin session; credentials are the authentication.',
  'POST /auth/login': 'Establishes the client session; credentials are the authentication.',
  'POST /identity/login':
    'Alias of POST /auth/login — the same handler, registered under both prefixes.',
  'POST /auth/register': 'Self-signup (IND-01). Rate limited; creates an unverified account.',
  'POST /identity/register': 'Alias of POST /auth/register — the same handler under both prefixes.',

  // Session renewal presents the refresh cookie, which IS the credential.
  'POST /admin/auth/refresh': 'Presents the admin refresh cookie; that is the credential.',
  'POST /auth/refresh': 'Presents the client refresh cookie; that is the credential.',
  'POST /identity/refresh': 'Alias of POST /auth/refresh — the same handler under both prefixes.',

  // Email-driven flows: the emailed token is the credential, and the recipient
  // has no session yet by definition.
  'GET /auth/verify-email': 'The emailed token is the credential.',
  'GET /identity/verify-email':
    'Alias of GET /auth/verify-email — the same handler under both prefixes.',
  'POST /auth/resend-verification': 'Pre-session by definition. Rate limited.',
  'POST /identity/resend-verification':
    'Alias of POST /auth/resend-verification — same handler, both prefixes.',
  'GET /admin/invite/validate': 'Pre-fills the accept form from an emailed token. Rate limited.',
  'POST /admin/invite/accept': 'The emailed invite token is the credential; no session exists yet.',

  // Infrastructure.
  'GET /health': 'Liveness. A load balancer cannot authenticate, and it reveals nothing.',
  'GET /health/ready': 'Readiness. Dependency status only, never connection detail.',

  // Authenticated by an HMAC over the raw body instead of a session — see
  // BRIDGE-CONTRACT and mt5-webhook.controller.ts. A missing MT5_BRIDGE_SECRET
  // refuses every push rather than failing open.
  'POST /webhooks/mt5/deals': 'Shared-secret token + HMAC-SHA256 over the raw body, not a session.',

  // Placeholders with no data and no side effects.
  'GET /trading/ping': 'Module liveness marker. Returns a constant.',
  'GET /partners/ping': 'Module liveness marker. Returns a constant.',
};

let app: INestApplication;
let discovery: DiscoveryService;
let reflector: Reflector;

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

interface RouteFacts {
  signature: string;
  /** Guard CLASS NAMES, not a count: which guard is attached is the declaration. */
  guards: string[];
  permissions: string[] | undefined;
  anyAdmin: string | undefined;
}

/** Every route in the application, with what it declares about access. */
function routes(): RouteFacts[] {
  const scanner = new MetadataScanner();
  const found: RouteFacts[] = [];

  for (const wrapper of discovery.getControllers()) {
    const instance = wrapper.instance as Record<string, unknown> | undefined;
    if (!instance) continue;

    const controllerClass = wrapper.metatype as (new (...args: never[]) => unknown) | undefined;
    if (!controllerClass) continue;

    // `@Controller(['auth','identity'])` registers the SAME handlers under two
    // prefixes, and `@Controller({ path, version })` stores an object. Both
    // appear in this codebase, so every form has to be handled or the scan
    // silently misses whole controllers.
    const prefixes = pathsOf(Reflect.getMetadata(PATH_METADATA, controllerClass));
    const classGuards = (Reflect.getMetadata(GUARDS_METADATA, controllerClass) ?? []) as unknown[];

    const prototype = Object.getPrototypeOf(instance) as object;
    for (const methodName of scanner.getAllMethodNames(prototype)) {
      const handler = instance[methodName] as ((...args: never[]) => unknown) | undefined;
      if (!handler) continue;

      const raw = Reflect.getMetadata(PATH_METADATA, handler) as unknown;
      if (raw === undefined) continue; // not a route

      const method = Reflect.getMetadata(METHOD_METADATA, handler) as number;
      const handlerGuards = (Reflect.getMetadata(GUARDS_METADATA, handler) ?? []) as unknown[];

      for (const prefix of prefixes) {
        for (const path of pathsOf(raw)) {
          found.push({
            signature: `${METHOD_NAMES[method]} ${joinPath(prefix, path)}`,
            guards: [...classGuards, ...handlerGuards].map(nameOf),
            permissions: reflector.get<string[]>(PERMISSIONS_KEY, handler),
            anyAdmin: reflector.get<string>(ANY_ADMIN_KEY, handler),
          });
        }
      }
    }
  }
  return found;
}

/** Every path a decorator declares, normalised, whatever shape it stored. */
function pathsOf(raw: unknown): string[] {
  if (typeof raw === 'string') return [normalise(raw)];
  if (Array.isArray(raw)) return raw.flatMap((entry) => pathsOf(entry));
  if (raw && typeof raw === 'object' && 'path' in raw) {
    return pathsOf(raw.path);
  }
  return [''];
}

/** A guard's class name, whether it was attached as a class or an instance. */
function nameOf(guard: unknown): string {
  if (typeof guard === 'function') return guard.name;
  if (guard && typeof guard === 'object') return guard.constructor.name;
  return String(guard);
}

const normalise = (p: string) => (p === '/' || p === '' ? '' : `/${p.replace(/^\/|\/$/g, '')}`);
const joinPath = (prefix: string, path: string) => `${prefix}${path}` || '/';

describe('R-4.2 every route declares how it is protected', () => {
  it('sees EVERY route the OpenAPI document sees', () => {
    /*
     * The load-bearing check on this whole file.
     *
     * Every assertion below is of the form "no route has problem X". A scan that
     * silently misses a controller reports a clean bill of health for routes it
     * never looked at — the most dangerous possible failure for a test whose
     * entire job is to notice an unprotected endpoint.
     *
     * So the inventory is cross-checked against the committed OpenAPI fixture,
     * which is generated by Nest's own Swagger scanner rather than by this file's
     * reflection. If the two ever disagree, this test stops being trustworthy and
     * says so, instead of quietly passing.
     */
    const fixture = JSON.parse(
      readFileSync(join(__dirname, 'fixtures', 'openapi-routes.json'), 'utf8'),
    ) as string[];

    const scanned = new Set(routes().map((r) => r.signature));
    // The fixture stores concrete paths ('GET /admin/kyc/{userId}'); reflection
    // stores Express patterns ('GET /admin/kyc/:userId'). Normalise to compare.
    const expected = fixture.map((route) => route.replace(/\{(\w+)\}/g, ':$1'));

    const missed = expected.filter((route) => !scanned.has(route));
    expect(
      missed,
      `The scan missed these routes, so its verdict cannot be trusted:\n${missed.join('\n')}`,
    ).toEqual([]);
  });

  it('has no route that is neither guarded nor explicitly public', () => {
    const undeclared = routes()
      .filter(
        (r) =>
          r.guards.length === 0 &&
          !(r.signature in PUBLIC_ROUTES) &&
          !(r.signature in HANDLER_AUTHENTICATED),
      )
      .map((r) => r.signature);

    expect(
      undeclared,
      `These routes declare no guard and are not listed in PUBLIC_ROUTES:\n` +
        undeclared.map((s) => `  ${s}`).join('\n') +
        `\n\nAdd a guard, or add the route to PUBLIC_ROUTES with the reason it is open.`,
    ).toEqual([]);
  });

  it('has no PUBLIC_ROUTES entry for a route that no longer exists', () => {
    // A stale exemption is worse than none: it reads as a considered decision
    // about a route, and silently covers the next route to take that path.
    const live = new Set(routes().map((r) => r.signature));
    const stale = Object.keys(PUBLIC_ROUTES).filter((s) => !live.has(s));
    expect(stale, `Stale PUBLIC_ROUTES entries: ${stale.join(', ')}`).toEqual([]);
  });

  it('gives every public route a stated reason', () => {
    for (const [route, reason] of Object.entries(PUBLIC_ROUTES)) {
      expect(reason.length, `${route} needs a real reason, not a placeholder`).toBeGreaterThan(25);
    }
  });

  it('has no admin route that is guarded but declares no permission', () => {
    // The fail-open this replaces: @UseGuards(PermissionsGuard) with no
    // @RequirePermissions used to admit any authenticated admin. The guard now
    // refuses at runtime; this catches it at build time, with the route named.
    /*
     * MasterAdminGuard is itself the declaration, and a stricter one than any
     * named permission: it admits only the master admin. Only PermissionsGuard
     * and the bare AdminGuard leave the question open, so only those must answer
     * it — with @RequirePermissions, or @AnyAdmin plus a reason.
     */
    const needsAnAnswer = routes().filter(
      (r) =>
        r.signature.includes(' /admin') &&
        r.guards.length > 0 &&
        !r.guards.includes('MasterAdminGuard'),
    );

    const silent = needsAnAnswer
      .filter((r) => (r.permissions?.length ?? 0) === 0 && !r.anyAdmin)
      .map((r) => r.signature);

    expect(
      silent,
      `Guarded admin routes with no declared permission:\n` +
        silent.map((s) => `  ${s}`).join('\n') +
        `\n\nAdd @RequirePermissions(...), or @AnyAdmin('reason') if any admin may do it.`,
    ).toEqual([]);
  });

  it('keeps the money endpoints on named permissions, never @AnyAdmin', () => {
    // Approving, rejecting or settling a withdrawal moves client funds. "Any
    // authenticated admin" is never the right answer for those, so this is a
    // separate, stricter assertion rather than a comment hoping someone reads it.
    // Admin money routes only. The client's own POST /payments/withdrawals is
    // authorised by ownership — the user id comes from their session, never from
    // the request — which is a different question (R-4.4), not a missing one.
    const moneyRoutes = routes().filter(
      (r) =>
        r.signature.includes(' /admin/') &&
        /\/(withdrawals|payouts|ledger|commission-plans)/.test(r.signature),
    );
    expect(moneyRoutes.length).toBeGreaterThan(0);

    for (const route of moneyRoutes) {
      expect(route.anyAdmin, `${route.signature} must not be @AnyAdmin`).toBeUndefined();
      expect(
        route.permissions?.length ?? 0,
        `${route.signature} needs a permission`,
      ).toBeGreaterThan(0);
    }
  });

  it('exempts nothing from CSRF that is not also public or a webhook', () => {
    // @NoCsrf is a real hole if it lands on an authenticated mutation. Keep it
    // to session-establishing and session-ending routes.
    const exempt = routes().filter((r) => reflectorHasNoCsrf(r.signature));
    for (const route of exempt) {
      const allowed =
        route.signature in PUBLIC_ROUTES ||
        /\/(logout|refresh|login|accept)/.test(route.signature) ||
        route.signature.includes('/webhooks/');
      expect(allowed, `${route.signature} is @NoCsrf but is an ordinary authenticated write`).toBe(
        true,
      );
    }
  });
});

/** Whether a route carries @NoCsrf, looked up the same way the guard does. */
function reflectorHasNoCsrf(signature: string): boolean {
  const scanner = new MetadataScanner();
  for (const wrapper of discovery.getControllers()) {
    const instance = wrapper.instance as Record<string, unknown> | undefined;
    const controllerClass = wrapper.metatype as (new (...args: never[]) => unknown) | undefined;
    if (!instance || !controllerClass) continue;

    const prefixes = pathsOf(Reflect.getMetadata(PATH_METADATA, controllerClass));
    const prototype = Object.getPrototypeOf(instance) as object;

    for (const methodName of scanner.getAllMethodNames(prototype)) {
      const handler = instance[methodName] as ((...args: never[]) => unknown) | undefined;
      if (!handler) continue;
      const raw = Reflect.getMetadata(PATH_METADATA, handler) as unknown;
      if (raw === undefined) continue;
      const method = Reflect.getMetadata(METHOD_METADATA, handler) as number;
      const matches = prefixes.some((prefix) =>
        pathsOf(raw).some(
          (path) => `${METHOD_NAMES[method]} ${joinPath(prefix, path)}` === signature,
        ),
      );
      if (!matches) continue;
      return Boolean(reflector.get<string>(NO_CSRF_KEY, handler));
    }
  }
  return false;
}
