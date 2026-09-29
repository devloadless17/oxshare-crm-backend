import { Injectable, UnauthorizedException } from '@nestjs/common';
import { PassportStrategy } from '@nestjs/passport';
import { Strategy } from 'passport-jwt';
import { COOKIE_BASES, readSessionCookie } from '../../../common/security/session-cookies';
import {
  isTokenKind,
  TOKEN_ALGORITHMS,
  TOKEN_CLOCK_TOLERANCE_SECONDS,
  TOKEN_AUDIENCE,
  TOKEN_ISSUER,
  TOKEN_KIND,
} from '../../../common/security/token-audience';
import { ConfigService } from '@nestjs/config';
import { Request } from 'express';
import { parsePortalId, UsersStore } from '../../../store/users.store';
import { RefreshTokensService } from '../../../common/security/refresh-tokens.service';

export interface JwtPayload {
  /** Which kind of token this is — see common/security/token-audience.ts. */
  typ?: string;
  sub: string;
  email: string;
  emailVerified: boolean;
  type: string;
  /** Issued-at, in SECONDS. Compared against `users.passwordChangedAt`. */
  iat?: number;
  /**
   * The refresh family this token belongs to — which LOGIN it came from.
   *
   * Optional because tokens minted before this claim existed do not carry it.
   * Those are treated as unrevokable and expire on their own within fifteen
   * minutes; refusing them instead would sign out every live session on deploy.
   */
  fam?: string;
}

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy, 'jwt') {
  constructor(
    config: ConfigService,
    private readonly users: UsersStore,
    private readonly refreshTokens: RefreshTokensService,
  ) {
    super({
      /*
       * COOKIE ONLY — R-3.1/R-3.2, and the last piece of the httpOnly migration.
       *
       * This list used to end with `ExtractJwt.fromAuthHeaderAsBearerToken()`,
       * which meant the entire portal surface — /kyc, /wallet, /payments, /me —
       * still accepted a token from an `Authorization` header. The admin surface
       * never did (admin.guard.ts reads the cookie and nothing else), and
       * admin-auth.service.ts says why in terms that apply just as well here:
       * two credential channels for one session means two threat models.
       *
       * It mattered concretely in two ways. An access token that reaches a log,
       * a Referer, a proxy or an error reporter was directly replayable for its
       * full 15 minutes — the exact exposure httpOnly cookies exist to remove.
       * And CsrfGuard skips any request carrying no session COOKIE
       * (csrf.guard.ts), so a header-authenticated request bypassed Origin and
       * anti-forgery checking entirely: sound reasoning about CSRF, applied to a
       * request that should not have been authenticating at all.
       *
       * Nothing sends the header. Both frontends are cookie-only and were
       * verified so, `Authorization` is out of the CORS allow-list in main.ts,
       * and Swagger no longer advertises the scheme.
       */
      jwtFromRequest: (req: Request) =>
        readSessionCookie(
          // Both spellings — see session-cookies.ts on why the name gains a
          // `__Host-` prefix once the deployment has TLS.
          req?.cookies as Record<string, string | undefined> | undefined,
          COOKIE_BASES.clientAccess,
        ) ?? null,
      ignoreExpiration: false,
      secretOrKey: config.getOrThrow<string>('JWT_ACCESS_SECRET'),
      // R-3.1: an admin token must be worthless here. The distinct secrets
      // already ensure that; this survives them being mixed up in a deploy.
      audience: TOKEN_AUDIENCE.portal,
      issuer: TOKEN_ISSUER,
      // Stated, never inherited from the key type — see token-audience.ts.
      algorithms: TOKEN_ALGORITHMS,
      // passport-jwt forwards this object to jsonwebtoken; `clockTolerance` is
      // not a top-level Strategy option and is silently ignored if placed there.
      jsonWebTokenOptions: { clockTolerance: TOKEN_CLOCK_TOLERANCE_SECONDS },
    });
  }

  async validate(payload: JwtPayload) {
    // A portal refresh token is signed with a different secret and so cannot
    // reach here — today. This keeps that true if the two secrets are ever
    // conflated in a deploy, the way ADMIN_JWT_SECRET conflated both kinds.
    if (!isTokenKind(payload, TOKEN_KIND.access)) {
      throw new UnauthorizedException('Invalid or expired token.');
    }
    // Identity comes from `sub` only. Falling back to the token's `email` claim
    // let a token naming one account resolve to another.
    // The subject is the client's Portal ID (0159). A token signed before it
    // carries a uuid: that is a stale session, answered 401 — never a 500.
    const clientId = parsePortalId(payload.sub);
    if (clientId === undefined) throw new UnauthorizedException('Please log in again.');
    const user = await this.users.findById(clientId);
    if (!user) throw new UnauthorizedException('User not found. Please log in again.');
    // Suspension takes effect on the next request — a live token is no shield.
    if (user.status === 'suspended') {
      throw new UnauthorizedException('Your account has been suspended.');
    }
    /*
     * Has this particular login been ended?
     *
     * Everything else here is a property of the ACCOUNT. This is the only check
     * that can distinguish one of the client's sessions from another, and
     * without it "sign out that device" reached the refresh family alone — the
     * access token minted from it kept authenticating for up to fifteen more
     * minutes. On an account that moves money, those are the fifteen minutes
     * that matter: they begin the moment the client spots a session they do not
     * recognise.
     *
     * It also carries the password change. `changePassword` revokes every family
     * and starts a fresh one for the caller, so their new token is live and every
     * other device is dead on its very next request rather than at its next
     * rotation.
     *
     * Costs one indexed lookup per authenticated request, and only for tokens
     * carrying the claim. Paid deliberately — the alternative is a revocation
     * control that does not revoke.
     */
    if (payload.fam && (await this.refreshTokens.familyIsRevoked('portal', payload.fam))) {
      throw new UnauthorizedException('That session has been signed out. Please log in again.');
    }
    /*
     * A password change takes effect on the next request too, for the same
     * reason and by the same mechanism as suspension above.
     *
     * Revoking refresh-token families ends a session's ability to RENEW. It
     * does not touch an access token that has already been issued, so without
     * this a client who changes their password because somebody is in their
     * account leaves that somebody up to fifteen more minutes of access.
     * Measured, not assumed: a second device kept answering 200 on /auth/me
     * immediately after a successful change.
     *
     * `iat` is in SECONDS; the column is a millisecond timestamp. That
     * truncation is the whole subtlety, and getting it wrong logs out the one
     * person who must not be.
     *
     * A token stamped `iat = S` was issued somewhere in the window [S, S+1).
     * `changePassword` re-issues the caller a token immediately after writing
     * the cutoff, so their new token can carry an `iat` whose SECOND began
     * before the cutoff instant - `1000` against a cutoff of `1000.500`. A
     * naive `iat * 1000 < cutoff` rejects it, and the client is signed out by
     * the very request that was meant to keep them in.
     *
     * So the comparison asks whether the token's whole second ended before the
     * change: reject only when `(iat + 1) * 1000 <= cutoff`. A token from ten
     * minutes ago fails that easily; one minted in the same second as the
     * change survives.
     *
     * It fails CLOSED at the boundary - a token issued in the final
     * milliseconds before the cutoff is rejected. The only token that can be is
     * the caller's own pre-change one, and they are being handed a new pair on
     * this very response.
     *
     * A null `passwordChangedAt` means NO cutoff. Every account predating the
     * column has one, and the migration that added it must not log them out.
     */
    if (
      user.passwordChangedAt &&
      payload.iat &&
      (payload.iat + 1) * 1000 <= user.passwordChangedAt.getTime()
    ) {
      throw new UnauthorizedException('Your password was changed. Please sign in again.');
    }
    return user;
  }
}
