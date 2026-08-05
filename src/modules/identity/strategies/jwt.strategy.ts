import { Injectable, UnauthorizedException } from '@nestjs/common';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { COOKIE_BASES, readSessionCookie } from '../../../common/security/session-cookies';
import {
  isTokenKind,
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
      jwtFromRequest: ExtractJwt.fromExtractors([
        // Cookie first, under both spellings — see session-cookies.ts on why the
        // name gains a `__Host-` prefix once the deployment has TLS.
        (req: Request) =>
          readSessionCookie(
            req?.cookies as Record<string, string | undefined> | undefined,
            COOKIE_BASES.clientAccess,
          ) ?? null,
        ExtractJwt.fromAuthHeaderAsBearerToken(),
      ]),
      ignoreExpiration: false,
      secretOrKey: config.getOrThrow<string>('JWT_ACCESS_SECRET'),
      // R-3.1: an admin token must be worthless here. The distinct secrets
      // already ensure that; this survives them being mixed up in a deploy.
      audience: TOKEN_AUDIENCE.portal,
      issuer: TOKEN_ISSUER,
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
