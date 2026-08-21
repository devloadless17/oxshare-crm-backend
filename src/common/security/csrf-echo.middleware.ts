import { Injectable, type NestMiddleware } from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';
import { isAdminSurface } from '../api-prefix';
import { COOKIE_BASES, CSRF_RESPONSE_HEADER, readSessionCookie } from './session-cookies';

/**
 * Return the caller's own anti-forgery token to them, on every response.
 *
 * ## The gap this fills, which is a COLD LOAD
 *
 * `issueCsrfToken` hands the token back when it is minted — on login and on
 * refresh. That is not enough on its own: a page that is simply reloaded makes
 * no login and no refresh call, so a frontend that keeps the token in memory
 * comes up holding nothing and its first write is refused. The old design had no
 * such gap because the page read the cookie, which survives a reload; a page on
 * a different host cannot (see `issueCsrfToken` for why it is on a different
 * host, and why that is not going to change).
 *
 * So the token travels on every response instead of on two of them. The client
 * re-learns it from whatever call the screen makes first — `/auth/me` on a cold
 * load — and there is no list of "endpoints that refresh the token" for anyone
 * to forget to add to.
 *
 * ## It echoes, it does not mint
 *
 * The value comes from the cookie the CALLER SENT. A request with no CSRF cookie
 * gets no header, so this can neither create a session nor extend one, and it
 * cannot disagree with the cookie the guard is about to compare against. Minting
 * stays where it was.
 *
 * Runs before the handler, so a login or refresh that mints a NEW token
 * overwrites this header with `res.setHeader` and the client learns the fresh
 * one rather than the token it arrived with.
 *
 * ## Why this discloses nothing
 *
 * It returns a value to the browser that already sent it, over a connection that
 * already carries the session cookie. The token is `httpOnly: false` by design,
 * and CORS exposes this header only to the two allowlisted origins — a foreign
 * page cannot read the response at all. The surface is chosen by the ROUTE via
 * `isAdminSurface`, exactly as `CsrfGuard` does, so an admin request can never
 * be handed the portal's token or the reverse.
 */
@Injectable()
export class CsrfEchoMiddleware implements NestMiddleware {
  use(req: Request, res: Response, next: NextFunction): void {
    const cookies = req.cookies as Record<string, string | undefined> | undefined;
    /*
     * `req.originalUrl`, NOT `req.path`.
     *
     * This middleware is mounted with `forRoutes('*')`, and inside a middleware
     * mounted that way Express reports `req.path` RELATIVE to the mount — which
     * is `"/"` for every request. `isAdminSurface("/")` is false, so every admin
     * request was classified as PORTAL, the middleware looked for the portal
     * cookie, found none, and echoed nothing. On a same-host deployment nobody
     * noticed: the frontend reads the real cookie and never needs the echo. On a
     * cross-host deployment the echo IS the only way the page learns its token,
     * so every write failed `failed anti-forgery validation`. Observed on
     * production, reproduced with a probe: path="/" originalUrl="/v1/admin/…".
     *
     * `originalUrl` is the full request path regardless of mount point. The
     * unit test that covered this handed the middleware a literal `path`, which
     * a real Express request never provides — it now builds the request the way
     * Express does.
     */
    const base = isAdminSurface(req.originalUrl) ? COOKIE_BASES.adminCsrf : COOKIE_BASES.portalCsrf;

    const token = readSessionCookie(cookies, base);
    if (token) res.setHeader(CSRF_RESPONSE_HEADER, token);

    next();
  }
}
