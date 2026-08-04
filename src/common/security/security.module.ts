import { Global, Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { CsrfService } from './csrf.service';
import { CsrfGuard } from './csrf.guard';
import { IdempotencyInterceptor } from './idempotency.interceptor';

/**
 * Global so that CsrfService is injectable wherever a session is established
 * (both auth services) without either module importing the other.
 *
 * JwtModule is registered with no default secret on purpose: CsrfGuard passes an
 * explicit secret per call, because it may be verifying either an admin token or
 * a client token and those are signed with different keys — that separation is
 * the whole point of R-3.1 and must not be blurred by a shared default here.
 */
@Global()
@Module({
  imports: [JwtModule.register({})],
  providers: [CsrfService, CsrfGuard, IdempotencyInterceptor],
  exports: [CsrfService, CsrfGuard, IdempotencyInterceptor],
})
export class SecurityModule {}
