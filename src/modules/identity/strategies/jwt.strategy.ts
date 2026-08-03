import { Injectable, UnauthorizedException } from '@nestjs/common';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { ConfigService } from '@nestjs/config';
import { Request } from 'express';
import { UsersStore } from '../../../store/users.store';

export interface JwtPayload {
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
        (req: Request) => req?.cookies?.['access_token'] ?? null,
        ExtractJwt.fromAuthHeaderAsBearerToken(),
      ]),
      ignoreExpiration: false,
      secretOrKey: config.getOrThrow<string>('JWT_ACCESS_SECRET'),
    });
  }

  async validate(payload: JwtPayload) {
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
