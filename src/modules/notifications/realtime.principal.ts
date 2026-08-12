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

/** `cookie: a=1; b=2` → `{ a: '1', b: '2' }`. */
export function parseCookieHeader(header: string | undefined): Record<string, string> {
  if (!header) return {};
  const jar: Record<string, string> = {};
  for (const pair of header.split(';')) {
    const separator = pair.indexOf('=');
    if (separator < 0) continue;
    const name = pair.slice(0, separator).trim();
    const value = pair.slice(separator + 1).trim();
    if (name) jar[name] = decodeURIComponent(value);
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
  async resolve(cookieHeader: string | undefined): Promise<RealtimePrincipal | null> {
    const cookies = parseCookieHeader(cookieHeader);

    /*
     * ADMIN FIRST, and the two are never both tried against one socket.
     *
     * R-3.1 keeps the surfaces separate: a portal token must be worthless on
     * the admin surface and vice versa. The cookie NAMES already separate
     * them, so presence decides which authenticator runs — and a browser
     * holding both (a developer signed into each app) gets the admin identity
     * on the admin app's socket and the client identity on the portal's,
     * because each app connects with its own origin and its own cookie.
     */
    const adminToken = readSessionCookie(cookies, COOKIE_BASES.adminAccess);
    if (adminToken) {
      const admin = await this.authenticateAdmin(cookies);
      if (admin) {
        return {
          recipient: { kind: 'admin', id: admin.id },
          expiresAt: this.expiryOf(adminToken, 'ADMIN_JWT_SECRET'),
        };
      }
      return null;
    }

    const clientToken = readSessionCookie(cookies, COOKIE_BASES.clientAccess);
    if (clientToken) {
      const userId = await this.authenticateClient(clientToken);
      if (userId) {
        return {
          recipient: { kind: 'client', id: userId },
          expiresAt: this.expiryOf(clientToken, 'JWT_ACCESS_SECRET'),
        };
      }
    }

    return null;
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

  private async authenticateClient(token: string): Promise<string | null> {
    try {
      const payload = this.jwt.verify<{ sub: string }>(token, {
        secret: this.config.getOrThrow<string>('JWT_ACCESS_SECRET'),
      });
      // The strategy owns the token-kind, suspension, revoked-family and
      // password-change checks. Calling it is what keeps this path honest.
      const user = (await this.clientStrategy.validate(payload as never)) as { id: string };
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
