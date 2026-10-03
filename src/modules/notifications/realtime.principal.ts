import { Injectable } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import { COOKIE_BASES, readSessionCookie } from '../../common/security/session-cookies';
import { AdminAuthenticator, type AuthenticatedAdmin } from '../admin/guards/admin.guard';
import { JwtStrategy } from '../identity/strategies/jwt.strategy';
import type { NotificationRecipient } from '../../store/notifications.store';

/**
 * Who is on the other end of a WebSocket, decided from the handshake cookies.
 *
 * ## Why this reuses the HTTP authenticators rather than re-checking tokens
 *
 * A socket lives for minutes and carries the same authority as a request, so
 * every check an HTTP call is subject to has to happen here too: the admin's
 * `status` re-read (a suspension bites on the next request — a socket must not
 * be a way to have no next request), the client's revoked-session check, the
 * password-change cut-off, the token KIND check that stops a portal token
 * working on the admin surface.
 *
 * Writing that again for sockets is how two authorization paths drift until
 * one of them is missing an enforcement point — the exact failure
 * `service-authorization.spec.ts` exists to prevent on the service layer. So
 * this calls `AdminAuthenticator.authenticate` and `JwtStrategy.validate`, the
 * same objects the guards use, and owns only the cookie parsing and the choice
 * between the two surfaces.
 */
export interface RealtimePrincipal {
  recipient: NotificationRecipient;
  /** When the presented access token expires, as epoch ms. See the gateway. */
  expiresAt: number | null;
}

/**
 * `cookie: a=1; b=2` → `{ a: '1', b: '2' }`.
 *
 * Every value is decoded DEFENSIVELY. `decodeURIComponent` throws a `URIError`
 * on a malformed escape — a bare `%` is enough — and the caller of this is an
 * unauthenticated handshake, so a thrown error here is a header an anonymous
 * stranger controls reaching an async path Nest does not await. That is a
 * one-request process kill, which is why the raw value is kept rather than the
 * error propagated: a cookie we cannot decode is a cookie that will not
 * authenticate, and refusing it is already the right answer.
 *
 * The HTTP surface never had this exposure because `cookie-parser` does the
 * same catch. Sockets do not go through it.
 */
export function parseCookieHeader(header: string | undefined): Record<string, string> {
  if (!header) return {};
  const jar: Record<string, string> = {};
  for (const pair of header.split(';')) {
    const separator = pair.indexOf('=');
    if (separator < 0) continue;
    const name = pair.slice(0, separator).trim();
    const raw = pair.slice(separator + 1).trim();
    if (!name) continue;
    try {
      jar[name] = decodeURIComponent(raw);
    } catch {
      jar[name] = raw;
    }
  }
  return jar;
}

@Injectable()
export class RealtimePrincipalResolver {
  constructor(
    private readonly adminAuthenticator: AdminAuthenticator,
    private readonly clientStrategy: JwtStrategy,
    private readonly jwt: JwtService,
    private readonly config: ConfigService,
  ) {}

  /**
   * Resolve the principal, or `null` when the handshake carries no valid
   * session.
   *
   * Never throws: a refused connection is an ordinary event (an expired tab, a
   * signed-out laptop), and an exception here would be logged as a server
   * fault on every one of them.
   */
  async resolve(
    cookieHeader: string | undefined,
    /**
     * Which APP opened this socket — the handshake `Origin`, already validated
     * against the allowlist by the gateway before this is called.
     *
     * `'admin'` and `'client'` rather than the raw URL, so the gateway owns the
     * comparison and this owns the consequence.
     */
    surface: 'admin' | 'client',
  ): Promise<RealtimePrincipal | null> {
    const cookies = parseCookieHeader(cookieHeader);

    /*
     * ── THE SURFACE DECIDES, NOT COOKIE PRESENCE ───────────────────────────
     *
     * This used to try the ADMIN cookie first and fall through to the client
     * one, on the reasoning that "each app connects with its own origin and its
     * own cookie". That reasoning was WRONG, and the bug it caused was visible:
     * cookies are scoped by HOST AND NOT BY PORT, so a developer signed into
     * both apps on localhost has one cookie jar. The portal's handshake carried
     * the admin cookie, this resolved it as an admin, and the portal's socket
     * joined `admin:<id>` — so a client's own browser received the admin work
     * queue's notifications ("a client requested a withdrawal") and NONE of
     * their own. The portal rendered them as the generic "Notification" toast,
     * because its catalogue rightly knows no `admin.*` kind.
     *
     * The same collision exists in production wherever the two apps sit on one
     * registrable domain and the cookies reach the API host together — the very
     * arrangement `session-cookies.ts` already warns about for `SameSite=Lax`.
     *
     * The origin is the only thing that says which APP is asking, so it is what
     * chooses the authenticator. R-3.1 is upheld more strictly than before: a
     * portal socket is now never even offered the admin authenticator, so an
     * admin session cannot silently become a portal socket's identity.
     */
    if (surface === 'admin') {
      const adminToken = readSessionCookie(cookies, COOKIE_BASES.adminAccess);
      if (!adminToken) return null;
      const admin = await this.authenticateAdmin(cookies);
      if (!admin) return null;
      return {
        recipient: { kind: 'admin', id: admin.id },
        expiresAt: this.expiryOf(adminToken, 'ADMIN_JWT_SECRET'),
      };
    }

    const clientToken = readSessionCookie(cookies, COOKIE_BASES.clientAccess);
    if (!clientToken) return null;
    const userId = await this.authenticateClient(clientToken);
    if (!userId) return null;
    return {
      recipient: { kind: 'client', id: userId },
      expiresAt: this.expiryOf(clientToken, 'JWT_ACCESS_SECRET'),
    };
  }

  private async authenticateAdmin(
    cookies: Record<string, string>,
  ): Promise<AuthenticatedAdmin | null> {
    try {
      /*
       * The authenticator reads `req.cookies` and nothing else on the cookie
       * path, so this shape is the whole request it needs. The API-key branch
       * reads a header that a browser never sends, and is deliberately not
       * offered here: a standing machine credential should not be able to hold
       * a socket open.
       */
      return await this.adminAuthenticator.authenticate({ cookies } as never);
    } catch {
      return null;
    }
  }

  private async authenticateClient(token: string): Promise<number | null> {
    try {
      // The strategy owns the whole check — audience, issuer, algorithm, token
      // kind, suspension, revoked family, password change — the same one the
      // HTTP guard runs, so a socket can never be laxer than a request.
      const user = (await this.clientStrategy.authenticateToken(token)) as { id: number };
      return user.id;
    } catch {
      return null;
    }
  }

  /**
   * When the presented token dies, so the gateway can close the socket then.
   *
   * A malformed or unreadable `exp` returns null, which the gateway treats as
   * "close on the standard ceiling" rather than "never close" — an unknown
   * expiry must not become an immortal session.
   */
  private expiryOf(token: string, secretKey: string): number | null {
    try {
      const payload = this.jwt.verify<{ exp?: number }>(token, {
        secret: this.config.getOrThrow<string>(secretKey),
      });
      return payload.exp ? payload.exp * 1000 : null;
    } catch {
      return null;
    }
  }
}
