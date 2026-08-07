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
  /*
   * Password reset — the caller is by definition someone who cannot sign in.
   *
   * Both are rate limited (R-3.5): forgot-password 3/hour, because it sends
   * mail to an address the caller names and is otherwise a user-enumeration
   * probe and a mail bomb aimed at someone else's inbox; reset-password 5/15min,
   * because the token is 122 bits of randomness so guessing is not the threat —
   * what needs bounding is an attacker grinding an unauthenticated lookup that
   * touches the database on every attempt.
   *
   * forgot-password also answers identically whether or not the account exists,
   * so being open here leaks nothing about who banks with OxShare.
   */
  'POST /auth/forgot-password':
    'Requests a reset link; the caller cannot sign in. Throttled 3/hour, answer is identical for unknown addresses.',
  'POST /identity/forgot-password':
    'Alias of POST /auth/forgot-password — the same handler, registered under both prefixes.',
  'POST /auth/reset-password':
    'Completes a reset; the emailed token IS the authentication. Single use, 30-minute TTL, throttled 5/15min.',
  'POST /identity/reset-password':
    'Alias of POST /auth/reset-password — the same handler, registered under both prefixes.',
  /*
   * The ADMIN half of the same idea — D-44. Reachable without a session because
   * the caller is an administrator who cannot sign in; that is the whole point.
   *
   * Unlike the portal's, this token is never self-requested: a second admin who
   * already holds high privilege arms it, and `refuseReset` refuses anyone
   * reaching above their own level. So the open route spends a credential that
   * an authenticated, audited, escalation-checked call created.
   */
  'POST /admin/password-reset/complete':
    'Spends an admin reset link; the emailed token IS the authentication. Single use ' +
    '(enforced in the UPDATE), 1-hour TTL, throttled 3/min, and it revokes every session ' +
    'for that admin. Arming it requires users.create plus the D-44 escalation guard.',

  /*
   * ENDING a session cannot require a live one either.
   *
   * These sat behind an auth guard, so an expired access token answered 401 and
   * cleared no cookies — the user was left holding a live thirty-day refresh
   * cookie with no server-side way to drop it. A laptop asleep past fifteen
   * minutes reproduced it every time: the first click after waking was Log out,
   * and it failed.
   *
   * Unguarded, not unauthenticated: identity comes from the FULLY VERIFIED
   * refresh cookie, so nobody can end somebody else's sessions, and the cookies
   * are cleared even when nothing verifies — clearing a cookie is not a
   * privileged act. Origin validation still runs, so no cross-site page can use
   * these to sign a user out.
   */
  'POST /auth/logout':
    'Ends the caller’s own session. Identity from the verified refresh cookie, so an expired access token can still sign out; Origin-checked.',
  'POST /identity/logout':
    'Alias of POST /auth/logout — the same handler, registered under both prefixes.',
  'POST /admin/auth/logout':
    'Ends the calling admin’s own session. Identity from the verified refresh cookie, so a slept laptop can still sign out; Origin-checked.',

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
  // POST, not GET, since R-3.9: a mail gateway or link scanner following the
  // emailed URL used to verify the address with nobody deciding to.
  'POST /auth/verify-email': 'The emailed token is the credential.',
  'POST /identity/verify-email':
    'Alias of POST /auth/verify-email — the same handler under both prefixes.',
  'POST /auth/resend-verification': 'Pre-session by definition. Rate limited.',
  'POST /identity/resend-verification':
    'Alias of POST /auth/resend-verification — same handler, both prefixes.',
  'GET /admin/invite/validate': 'Pre-fills the accept form from an emailed token. Rate limited.',
  'POST /admin/invite/accept': 'The emailed invite token is the credential; no session exists yet.',

  // Infrastructure.
  'GET /health': 'Liveness. A load balancer cannot authenticate, and it reveals nothing.',
  'GET /health/ready': 'Readiness. Dependency status only, never connection detail.',

  // Placeholders with no data and no side effects.

  /*
   * The operator's currency list — codes, names, symbols, display precision.
   *
   * Open because it is the same answer for everybody and for nobody in
   * particular: no client data, no balances, nothing that varies by who asks.
   * It is also needed BEFORE a session exists, since the registration screen
   * names the currency a new client's wallet opens in, so requiring one would
   * 401 the screen that most needs it.
   *
   * Disabled currencies never leave the service, so this cannot advertise
   * something a client is unable to hold. Every WRITE, and the disabled rows,
   * are on /admin/currencies behind settings.view / settings.manage.
   */
  'GET /currencies':
    'Operator currency list. No client data, and the signed-out registration screen needs it.',
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
    /*
     * Two normalisations before comparing.
     *
     * 1. The fixture stores concrete paths ('GET /admin/kyc/{userId}');
     *    reflection stores Express patterns ('GET /admin/kyc/:userId').
     * 2. The fixture is generated from the OpenAPI document, which is built
     *    AFTER setGlobalPrefix, so every path carries `/v1` (R-2.1). This scan
     *    reads controller decorators, which never see the prefix — it is applied
     *    by the app, not declared on the class. Strip it here rather than
     *    teaching the scanner about it: the prefix is a deployment concern and
     *    what this test is about is whether each HANDLER declares its
     *    protection.
     */
    const expected = fixture.map((route) =>
      route.replace(/\{(\w+)\}/g, ':$1').replace(/ \/v1\//, ' /'),
    );

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

  /*
   * ── Every CLIENT route requires a verified email, or says why not ──────────
   *
   * The same inversion as the guard check above, for the same reason. Login now
   * refuses an unverified address, but that only stops a session being ISSUED:
   * a session minted before that check existed, or by any future path that
   * mints one, still carries a valid cookie. The API is where it has to hold.
   *
   * The gap this was written after: `/wallet` — balances and the client's own
   * ledger — ran on `JwtAuthGuard` alone, while KYC, IB and payments all
   * carried `EmailVerifiedGuard`. Nothing distinguished "decided not to" from
   * "forgot", which is exactly the condition this file exists to eliminate.
   *
   * The exemptions below are the decision, and they follow one rule: email
   * verification gates PRODUCT surfaces, never identity or account recovery. A
   * person who cannot verify must still be able to discover that fact, change a
   * compromised password, and end their sessions.
   */
  /*
   * `AuthController` declares TWO prefixes — @Controller(['auth', 'identity'])
   * — so each of its routes registers under both and is exempted under both.
   * Expanded from one list so the pair cannot drift.
   */
  const IDENTITY_EXEMPTIONS: Array<[string, string]> = [
    [
      'GET /me',
      'The portal calls this on load to DISCOVER whether the address is verified. Guarding it ' +
        'would leave the app unable to tell the user why they are blocked.',
    ],
    [
      'POST /change-password',
      'Account recovery. Someone who cannot verify must still be able to change a password they ' +
        'believe is compromised.',
    ],
    ['GET /sessions', 'Account recovery — seeing where you are signed in.'],
    ['DELETE /sessions/:id', 'Account recovery — ending a session you do not recognise.'],
    ['POST /me/avatar', 'Profile self-management, not a product surface. No client data.'],
    ['DELETE /me/avatar', 'Profile self-management, not a product surface. No client data.'],
  ];

  const VERIFICATION_EXEMPT: Record<string, string> = {
    'GET /platforms':
      'Download links for the trading terminal — operator content, identical for every caller, ' +
      'and deliberately readable before verification (see the controller).',
    'GET /uploads/kyc/:file':
      'Authenticates INSIDE the handler because it serves two identities. The CLIENT branch ' +
      'checks emailVerified there; a controller guard would test the column on an ADMIN, who ' +
      'has none, and lock every reviewer out of every document.',
  };
  for (const [route, reason] of IDENTITY_EXEMPTIONS) {
    const [method, path] = route.split(' ');
    for (const prefix of ['auth', 'identity']) {
      VERIFICATION_EXEMPT[`${method} /${prefix}${path}`] = reason;
    }
  }

  it('has no client route that skips EmailVerifiedGuard without saying why', () => {
    const unguarded = routes()
      .filter((r) => {
        // Admin routes are a different surface with a different principal —
        // an administrator has no `emailVerified` column at all.
        if (r.signature.includes(' /admin')) return false;
        // Only routes that authenticate a CLIENT are in scope.
        if (!r.guards.includes('JwtAuthGuard')) return false;
        return !r.guards.includes('EmailVerifiedGuard');
      })
      .map((r) => r.signature)
      .filter((s) => !(s in VERIFICATION_EXEMPT));

    expect(
      unguarded,
      `These client routes authenticate but never check emailVerified:\n` +
        unguarded.map((s) => `  ${s}`).join('\n') +
        `\n\nAdd EmailVerifiedGuard, or add the route to VERIFICATION_EXEMPT with the reason.`,
    ).toEqual([]);
  });

  it('has no stale VERIFICATION_EXEMPT entry', () => {
    // Same hazard as a stale PUBLIC_ROUTES entry: it reads as a considered
    // decision and silently covers the next route to take that path.
    const live = new Set(routes().map((r) => r.signature));
    const stale = Object.keys(VERIFICATION_EXEMPT).filter((s) => !live.has(s));
    expect(stale, `Stale VERIFICATION_EXEMPT entries: ${stale.join(', ')}`).toEqual([]);
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

  it('never declares a permission that no guard on the route can read', () => {
    /*
     * The failure this catches, which the assertion above cannot see.
     *
     * `@RequirePermissions('settings.manage')` was paired with
     * `@UseGuards(AdminGuard)` on both `/admin/platforms` routes. Only
     * `PermissionsGuard` reads `PERMISSIONS_KEY`; `AdminGuard` authenticates and
     * returns. So the decorator was decoration, and any authenticated admin
     * could rewrite the executable download URL handed to every client.
     *
     * The route looked correct in review — the permission is right there in the
     * diff — and the previous assertion passed, because it only asks whether a
     * permission was DECLARED. This asks whether anything ENFORCES it.
     *
     * `MasterAdminGuard` is stricter than any named permission, so a route
     * carrying it is answered whether or not the permission is also read.
     */
    const declaredButUnread = routes()
      .filter(
        (r) =>
          (r.permissions?.length ?? 0) > 0 &&
          !r.guards.includes('PermissionsGuard') &&
          !r.guards.includes('MasterAdminGuard'),
      )
      .map((r) => `${r.signature}  [guards: ${r.guards.join(', ') || 'none'}]`);

    expect(
      declaredButUnread,
      'These routes declare @RequirePermissions but carry no guard that reads it, ' +
        'so the permission is not enforced:\n' +
        declaredButUnread.map((s) => `  ${s}`).join('\n') +
        '\n\nUse @UseGuards(PermissionsGuard).',
    ).toEqual([]);
  });

  /*
   * RESTORED for partner approval, as the note left here asked.
   *
   * The original filtered withdrawals|payouts|ledger|commission-plans and went
   * with those routes. It is back over the partner surface for the same reason:
   * approving an application creates somebody the platform will PAY, so "any
   * authenticated admin" is not an acceptable answer on these routes either.
   *
   * The `toBeGreaterThan(0)` guard comes back with it, and it is the important
   * half. Without it, renaming the route prefix turns this into a test that
   * matches nothing and passes forever — which is precisely how a check like
   * this dies quietly.
   *
   * The money rebuild should add its own prefixes to this list rather than
   * writing a second copy of this test.
   */
  it('requires a named permission on every partner-decision route', () => {
    const partnerRoutes = routes().filter((r) => /\/admin\/ib\//.test(r.signature));

    expect(
      partnerRoutes.length,
      'No /admin/ib/ routes matched. If the prefix changed, update this filter — ' +
        'do not leave an assertion that silently matches nothing.',
    ).toBeGreaterThan(0);

    const unnamed = partnerRoutes
      .filter((r) => (r.permissions?.length ?? 0) === 0)
      .map((r) => r.signature);

    expect(
      unnamed,
      'These partner routes carry no named permission:\n' +
        unnamed.map((s) => `  ${s}`).join('\n') +
        '\n\nApproving a partner grants commission-earning rights; @AnyAdmin is not enough.',
    ).toEqual([]);
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
