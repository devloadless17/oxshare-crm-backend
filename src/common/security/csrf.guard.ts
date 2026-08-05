import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  Logger,
  SetMetadata,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import { CsrfService } from './csrf.service';
import { COOKIE_BASES, readSessionCookie } from './session-cookies';
import { TOKEN_AUDIENCE, TOKEN_ISSUER } from './token-audience';
import { safeLogPath } from '../logging/redact';
import { stripApiPrefix } from '../api-prefix';

/**
 * Opt a route out of CSRF and Origin checking. Use sparingly and say why.
 */
export const NO_CSRF_KEY = 'no_csrf';
export const NoCsrf = (reason: string) => SetMetadata(NO_CSRF_KEY, reason);

/** The header the frontends echo the CSRF cookie into. App-specific, so it
 *  cannot collide with a header another OxShare site already uses. */
export const CSRF_HEADER = 'x-oxshare-csrf';

const STATE_CHANGING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/**
 * Origin validation and CSRF, on every cookie-authenticated state change.
 *
 * PLATFORM-CONVENTIONS R-3.6. Registered globally (APP_GUARD) rather than
 * per-route on purpose: an endpoint that forgets to opt IN to CSRF is
 * indistinguishable from one that never needed it, and that is how a
 * money-moving route ends up unprotected. Here the default is protection and
 * skipping is explicit.
 *
 * The trigger condition is **"does this request carry a session cookie"**, not
 * "is this route in a list". That single test gets every case right without a
 * registry to maintain:
 *
 *   - Login, register, password reset — no session cookie yet, nothing to
 *     forge, skipped automatically.
 *   - The MT5 bridge webhook — no cookies at all; it authenticates with an HMAC
 *     over the raw body and would have no Origin header either. Skipped.
 *   - Every authenticated mutation — protected, including ones written after
 *     this file, by anyone who never reads it.
 *
 * Why both checks, when either would usually do:
 *
 *   - **Origin/Referer** is the primary control here. §3.0: sibling OxShare
 *     hosts are same-site, so SameSite=Lax does not stop them; an exact origin
 *     match does.
 *   - **The CSRF token** covers what Origin cannot: a browser or proxy that
 *     omits the header, and the cookie-tossing case where a sibling host writes
 *     our cookie. The token is bound to the session by HMAC, so a tossed value
 *     fails even when echoed perfectly (csrf.service.ts).
 */
@Injectable()
export class CsrfGuard implements CanActivate {
  private readonly logger = new Logger(CsrfGuard.name);

  constructor(
    private readonly reflector: Reflector,
    private readonly csrf: CsrfService,
    private readonly jwt: JwtService,
    private readonly config: ConfigService,
  ) {}

  canActivate(context: ExecutionContext): boolean {
    if (context.getType() !== 'http') return true;

    const req = context.switchToHttp().getRequest<Request>();
    if (!STATE_CHANGING.has(req.method)) return true;

    const exemption = this.reflector.getAllAndOverride<string>(NO_CSRF_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (exemption) return true;

    const session = this.resolveSession(req);
    // No session cookie for THIS surface means no ambient authority to abuse.
    // Whatever else authenticates the request (an HMAC, nothing at all) is not
    // something a browser attaches automatically, which is the premise of CSRF.
    if (!session) return true;

    this.assertOriginAllowed(req);
    this.assertTokenValid(req, session);
    return true;
  }

  /**
   * The authenticated principal, from the session cookie only.
   *
   * Deliberately re-verifies the JWT here rather than reading `req.admin` set by
   * an auth guard: a GLOBAL guard runs before route-level guards, so that
   * property does not exist yet. Verifying the signature ourselves is what lets
   * this stay global — and therefore default-on — instead of being one more
   * decorator to remember.
   */
  private resolveSession(req: Request): { subject: string; csrfBase: string } | null {
    const cookies = req.cookies as Record<string, string | undefined> | undefined;

    /*
     * The SURFACE is chosen by the route, not by "whichever cookie happens to be
     * present" — R-3.1 says these are two entirely separate surfaces, and the
     * guard has to honour that or it draws conclusions from the wrong session.
     *
     * The bug that forced this: cookies are scoped by host and path and IGNORE
     * the port, so on localhost the portal (:3000) and the admin app (:3002)
     * share one cookie jar. A developer who logged into the portal and then
     * opened the admin login page sent a PORTAL session cookie to
     * `POST /admin/auth/login`. The guard read it as "this request is
     * authenticated", demanded an anti-forgery token for a session that has
     * nothing to do with the admin surface, and refused the login — locking the
     * user out of the admin panel entirely, with a message about anti-forgery
     * validation that pointed nowhere useful.
     *
     * Matched against the route with the version prefix stripped, NEVER against
     * a literal. This line read `req.path.startsWith('/admin')` until serving
     * every route under `/v1` made it false for every admin request: the guard
     * then took the portal branch, found no portal cookie, and concluded there
     * was no ambient authority to protect — waving through every admin write,
     * including approving and settling withdrawals. The check was disarmed by a
     * change in a different file that never mentioned this one.
     */
    const isAdminSurface = stripApiPrefix(req.path).startsWith('/admin');

    const [cookieBase, csrfBase, secretKey, devFallback, audience] = isAdminSurface
      ? ([
          COOKIE_BASES.adminAccess,
          COOKIE_BASES.adminCsrf,
          'ADMIN_JWT_SECRET',
          'oxshare-admin-secret-dev',
          TOKEN_AUDIENCE.admin,
        ] as const)
      : ([
          COOKIE_BASES.clientAccess,
          COOKIE_BASES.portalCsrf,
          'JWT_ACCESS_SECRET',
          'oxshare-access-secret-dev',
          TOKEN_AUDIENCE.portal,
        ] as const);

    const token = readSessionCookie(cookies, cookieBase);
    if (!token) return null;

    const subject = this.subjectOf(token, secretKey, devFallback, audience);
    // A cookie that is present but unverifiable is not a session. The auth guard
    // will reject it with a 401, which is a clearer answer than a CSRF 403.
    return subject ? { subject, csrfBase } : null;
  }

  private subjectOf(
    token: string,
    configKey: string,
    devFallback: string,
    audience: string,
  ): string | null {
    try {
      const payload = this.jwt.verify<{ sub?: string }>(token, {
        secret: this.config.get<string>(configKey) ?? devFallback,
        audience,
        issuer: TOKEN_ISSUER,
      });
      return payload.sub ?? null;
    } catch {
      return null;
    }
  }

  /**
   * Exact full-origin equality against the configured allowlist.
   *
   * Never a suffix test: `origin.endsWith('.oxshare.com')` also matches
   * `evil-oxshare.com`, and a regex on the domain matches
   * `oxshare.com.attacker.net`. Both re-admit precisely the attacker this guard
   * exists to exclude.
   *
   * A request with neither Origin nor Referer is REJECTED rather than allowed.
   * Every browser sends Origin on a cross-origin state change, so the absent
   * case is either a non-browser client — which should not be holding a session
   * cookie — or a deliberate attempt to dodge this check.
   */
  private assertOriginAllowed(req: Request): void {
    const allowed = [
      this.config.get<string>('PORTAL_URL') ?? 'http://localhost:3000',
      this.config.get<string>('ADMIN_URL') ?? 'http://localhost:3002',
    ];

    const origin = req.get('origin');
    if (origin) {
      if (allowed.includes(origin)) return;
      this.reject(req, `origin ${origin} is not allowed`);
    }

    const referer = req.get('referer');
    if (referer) {
      // Compare the ORIGIN of the referer, not the whole URL, and let an invalid
      // URL fall through to the rejection below rather than throwing.
      try {
        if (allowed.includes(new URL(referer).origin)) return;
      } catch {
        /* malformed Referer — treated as absent */
      }
      this.reject(req, `referer ${referer} is not allowed`);
    }

    this.reject(req, 'neither Origin nor Referer was present on a cookie-authenticated write');
  }

  private assertTokenValid(req: Request, session: { subject: string; csrfBase: string }): void {
    const cookies = req.cookies as Record<string, string | undefined> | undefined;
    const fromCookie = readSessionCookie(cookies, session.csrfBase);
    const header = req.get(CSRF_HEADER);

    if (!header) this.reject(req, `missing ${CSRF_HEADER} header`);
    // Double submit: a cross-origin page cannot set a custom header without a
    // preflight this API refuses, so matching the cookie proves same-origin JS.
    if (!fromCookie || fromCookie !== header) this.reject(req, 'CSRF cookie and header differ');
    // And the token must prove it was minted for THIS session, which is what
    // survives a sibling host tossing us a cookie it chose (§3.0).
    if (!this.csrf.verify(session.subject, header)) {
      this.reject(req, 'CSRF token was not issued for this session');
    }
  }

  private reject(req: Request, reason: string): never {
    // Logged with the reason, answered without it: telling a caller which of the
    // checks it failed is a free tutorial on the ones it passed.
    this.logger.warn(`CSRF rejected ${req.method} ${safeLogPath(req.originalUrl)}: ${reason}`);
    throw new ForbiddenException('Request rejected: failed anti-forgery validation.');
  }
}
