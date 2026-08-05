import { Global, Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { CsrfService } from './csrf.service';
import { CsrfGuard } from './csrf.guard';
import { IdempotencyInterceptor } from './idempotency.interceptor';
import { RefreshTokensService } from './refresh-tokens.service';
import { PasswordService } from './password.service';
import { LoginAttemptsService } from './login-attempts.service';
import { MoneyLimits } from '../../config/money-limits';
import { SecurityScheduler } from './security.scheduler';

/**
 * The cross-cutting security services, available everywhere.
 *
 * @Global so that CsrfService reaches both auth services, and MoneyLimits reaches
 * the payments and partners modules, without any of them importing each other —
 * these are policy, not domain, and a domain module should not have to know
 * where policy lives.
 *
 * JwtModule is registered with no default secret on purpose: CsrfGuard passes an
 * explicit secret per call, because it may be verifying either an admin token or
 * a client token and those are signed with different keys — that separation is
 * the whole point of R-3.1 and must not be blurred by a shared default here.
 */
@Global()
@Module({
  imports: [JwtModule.register({})],
  providers: [
    CsrfService,
    CsrfGuard,
    IdempotencyInterceptor,
    RefreshTokensService,
    LoginAttemptsService,
    PasswordService,
    MoneyLimits,
    SecurityScheduler,
  ],
  exports: [
    CsrfService,
    CsrfGuard,
    IdempotencyInterceptor,
    RefreshTokensService,
    LoginAttemptsService,
    PasswordService,
    MoneyLimits,
  ],
})
export class SecurityModule {}
