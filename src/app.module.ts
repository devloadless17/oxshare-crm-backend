import { Module } from '@nestjs/common';
import { ReplayNonceModule } from './common/security/replay-nonce.module';
import { ConfigModule } from '@nestjs/config';
import { ScheduleModule } from '@nestjs/schedule';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { APP_FILTER, APP_GUARD } from '@nestjs/core';
import { MiddlewareConsumer, NestModule } from '@nestjs/common';
import { AllExceptionsFilter } from './common/filters/all-exceptions.filter';
import { RequestIdMiddleware } from './common/middleware/request-id.middleware';
import { validateEnv } from './config/env.validation';
import { DatabaseModule } from './database/database.module';
import { StoreModule } from './store/store.module';
import { EmailModule } from './modules/email/email.module';
import { IdentityModule } from './modules/identity/identity.module';
import { TradingModule } from './modules/trading/trading.module';
import { WalletModule } from './modules/wallet/wallet.module';
import { PaymentsModule } from './modules/payments/payments.module';
import { PartnersModule } from './modules/partners/partners.module';
import { ComplianceModule } from './modules/compliance/compliance.module';
import { AdminModule } from './modules/admin/admin.module';
import { HealthModule } from './modules/health/health.module';
import { SecurityModule } from './common/security/security.module';
import { CsrfGuard } from './common/security/csrf.guard';

@Module({
  imports: [
    ReplayNonceModule,
    // Global config — loads .env, validated at boot (refuses to start on invalid)
    ConfigModule.forRoot({ isGlobal: true, validate: validateEnv }),

    // §9 repeatable jobs. Interim host for the confirm job until BullMQ lands.
    ScheduleModule.forRoot(),

    // §8.4 mandates rate limiting ("3 sends per 15 min per user, plus per-IP
    // throttle") and there was none anywhere — login, admin login, refresh and
    // the unauthenticated invite-validate endpoint were all unprotected against
    // credential stuffing and token guessing.
    // Named 'default' so per-route @Throttle({ default: ... }) overrides bind
    // to it — with custom names the overrides silently do nothing.
    ThrottlerModule.forRoot([{ name: 'default', ttl: 60_000, limit: 120 }]),

    // Infrastructure
    DatabaseModule,
    StoreModule,
    EmailModule,
    SecurityModule,
    HealthModule,

    // Domain modules
    IdentityModule,
    TradingModule,
    WalletModule,
    PaymentsModule,
    PartnersModule,
    ComplianceModule,
    AdminModule,
  ],
  providers: [
    // The one place domain errors become HTTP responses, and where an
    // unexpected error is logged in full but answered generically.
    { provide: APP_FILTER, useClass: AllExceptionsFilter },
    // Global baseline throttle; sensitive routes tighten it with @Throttle.
    { provide: APP_GUARD, useClass: ThrottlerGuard },
    /*
     * Origin validation + CSRF on every cookie-authenticated state change
     * (PLATFORM-CONVENTIONS R-3.6). GLOBAL rather than per-route deliberately:
     * a route that forgets to opt in looks exactly like one that never needed
     * protecting, and that is how a money-moving endpoint ends up open. Routes
     * with no session cookie are skipped automatically — login, the bridge
     * webhook — so there is no list to maintain and nothing to forget.
     */
    // useExisting, not useClass: CsrfGuard's own dependencies (JwtService) live
    // in SecurityModule, so instantiating a second copy here fails to resolve
    // them. This reuses the instance that module already built.
    { provide: APP_GUARD, useExisting: CsrfGuard },
  ],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(RequestIdMiddleware).forRoutes('*');
  }
}
