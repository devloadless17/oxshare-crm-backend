import { Injectable, UnauthorizedException } from '@nestjs/common';
import { PassportStrategy } from '@nestjs/passport';
import { Strategy } from 'passport-jwt';
import { COOKIE_BASES, readSessionCookie } from '../../../common/security/session-cookies';
import {
  isTokenKind,
  TOKEN_ALGORITHMS,
  TOKEN_AUDIENCE,
  TOKEN_ISSUER,
  TOKEN_KIND,
} from '../../../common/security/token-audience';
import { ConfigService } from '@nestjs/config';
import { Request } from 'express';
import { UsersStore } from '../../../store/users.store';

export interface JwtPayload {
  /** Which kind of token this is — see common/security/token-audience.ts. */
  typ?: string;
  sub: string;
  email: string;
  emailVerified: boolean;
  type: string;
}

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy, 'jwt') {
  constructor(
    config: ConfigService,
    private readonly users: UsersStore,
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
    const user = await this.users.findById(payload.sub);
    if (!user) throw new UnauthorizedException('User not found. Please log in again.');
    // Suspension takes effect on the next request — a live token is no shield.
    if (user.status === 'suspended') {
      throw new UnauthorizedException('Your account has been suspended.');
    }
    return user;
  }
}
