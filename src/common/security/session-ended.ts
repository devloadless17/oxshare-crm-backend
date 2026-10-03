import { UnauthorizedException } from '@nestjs/common';

/**
 * A session that WAS valid and has since been ended — suspension, a revoked
 * family, a password change.
 *
 * Still a 401 with exactly the body the authenticators always sent; the
 * subclass exists so a caller resolving TWO principals (the `/uploads` file
 * routes) can tell a refusal reached ON PURPOSE, which must propagate, from
 * "this is not that kind of session at all", which falls through to the other
 * audience. Thrown by `AdminAuthenticator` and `JwtStrategy` only.
 */
export class SessionEndedException extends UnauthorizedException {}
