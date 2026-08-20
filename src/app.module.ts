/*
 * ⚠️ FIRST IMPORT, and it must stay first — this line has a side effect the
 * scheduler declarations below depend on.
 *
 * `@Cron(process.env.SOME_CRON ?? DEFAULT)` is evaluated when the scheduler
 * class is DEFINED, which happens while the imports below are being resolved.
 * `ConfigModule` reads `.env` too, but only during module INITIALISATION — long
 * after every decorator argument has been computed. Without this line
 * `process.env.SOME_CRON` is undefined at the one moment it is read, and every
 * schedule silently falls back to its hardcoded default.
 *
 * Not theoretical; it was live. `.env` set the commission confirm job to every
 * five minutes while `SchedulerRegistry` had it registered HOURLY, so accruals
 * sat pending for up to an hour on a deployment whose configuration said five
 * minutes. Nothing reported a conflict, because the value IS read — by
 * `validateEnv`, which accepted it — so the setting looked applied everywhere a
 * human would think to look. The same silence hid it for TRANSFER_RESUME_CRON.
 *
 * It lives HERE rather than in `main.ts` because this is the file that pulls the
 * schedulers in: a test, a script or a REPL that builds AppModule directly never
 * runs `main.ts` and would keep the broken behaviour.
 *
 * dotenv does not overwrite variables that are already set, so a real
 * environment — production, CI, a container — still wins over the file.
 * `drizzle.config.ts` records the same trap one layer over.
 */
import 'dotenv/config';
import { Module } from '@nestjs/common';
import { ReplayNonceModule } from './common/security/replay-nonce.module';
import { ConfigModule } from '@nestjs/config';
import { ScheduleModule } from '@nestjs/schedule';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { APP_FILTER, APP_GUARD } from '@nestjs/core';
import { MiddlewareConsumer, NestModule } from '@nestjs/common';
import { AllExceptionsFilter } from './common/filters/all-exceptions.filter';
import { RequestIdMiddleware } from './common/middleware/request-id.middleware';
import { CsrfEchoMiddleware } from './common/security/csrf-echo.middleware';
import { validateEnv } from './config/env.validation';
import { DatabaseModule } from './database/database.module';
import { StoreModule } from './store/store.module';
import { UploadsModule } from './common/uploads/uploads.module';
import { EmailModule } from './modules/email/email.module';
import { NotificationsModule } from './modules/notifications/notifications.module';
import { IdentityModule } from './modules/identity/identity.module';
import { PlatformsModule } from './modules/platforms/platforms.module';
import { CurrenciesModule } from './modules/currencies/currencies.module';
import { LeveragesModule } from './modules/leverages/leverages.module';
import { IbModule } from './modules/ib/ib.module';
import { WalletModule } from './modules/wallet/wallet.module';
import { TradingModule } from './modules/trading/trading.module';
import { PaymentsModule } from './modules/payments/payments.module';
import { SettingsModule } from './modules/settings/settings.module';
import { ProductsModule } from './modules/products/products.module';
import { ComplianceModule } from './modules/compliance/compliance.module';
import { AdminModule } from './modules/admin/admin.module';
import { HealthModule } from './modules/health/health.module';
import { SecurityModule } from './common/security/security.module';
import { CsrfGuard } from './common/security/csrf.guard';
import { RedisThrottlerStorage } from './common/security/redis-throttler.storage';

@Module({
  imports: [
    ReplayNonceModule,
    /*
     * Global config — loads .env in EVERY environment, production included,
     * validated at boot (refuses to start on invalid).
     *
     * This previously set `ignoreEnvFile: NODE_ENV === 'production'`, on the
     * reasoning that a container gets its configuration from the orchestrator and
     * a stray `/app/.env` is strictly a hazard: ConfigModule fills in only the
     * keys ABSENT from process.env, so a file that shouldn't be in the image
     * would silently backfill whatever the real deployment forgot, and
     * `validateEnv` would see the merged object and pass.
     *
     * That reasoning holds for a container. It does not describe how this system
     * is actually deployed on the Windows VPS, where there is no orchestrator to
     * inject 25 variables and the .env file IS the configuration — maintained,
     * reviewed and edited in one place. Ignoring it there did not make config
     * safer; it split the truth in two, because the file stayed on disk looking
     * authoritative while the process read a separate machine environment block.
     *
     * THE TRADE-OFF IS REAL AND UNCHANGED: a value missing from the environment
     * now falls back to this file rather than refusing to boot. What keeps that
     * honest is that .env is the DECLARED source here rather than a leftover — it
     * is gitignored, it is not copied into any image (.dockerignore still
     * excludes it), and `validateEnv` still refuses the merged result if the
     * outcome is invalid. If this ever runs in a container again, set
     * `ignoreEnvFile: true` there explicitly rather than deriving it from
     * NODE_ENV, so the choice is stated by the deployment that needs it.
     */
    ConfigModule.forRoot({
      isGlobal: true,
      validate: validateEnv,
      ignoreEnvFile: false,
    }),

    // §9 repeatable jobs. Interim host for the confirm job until BullMQ lands.
    ScheduleModule.forRoot(),

    // §8.4 mandates rate limiting ("3 sends per 15 min per user, plus per-IP
    // throttle") and there was none anywhere — login, admin login, refresh and
    // the unauthenticated invite-validate endpoint were all unprotected against
    // credential stuffing and token guessing.
    // Named 'default' so per-route @Throttle({ default: ... }) overrides bind
    // to it — with custom names the overrides silently do nothing.
    /*
     * Counters in REDIS, not process memory — R-3.5.
     *
     * The default in-memory storage resets on every deploy and is per-process,
     * so with two replicas "5 login attempts per minute" is really ten. Neither
     * property is visible in development, and both weaken exactly the limits
     * that matter in production.
     *
     * `useExisting` so it is the same instance the DI container built (and the
     * same Redis connection everything else uses); a second copy here would
     * have its own back-off state and its own opinion about whether Redis is up.
     */
    ThrottlerModule.forRootAsync({
      inject: [RedisThrottlerStorage],
      useFactory: (storage: RedisThrottlerStorage) => ({
        throttlers: [{ name: 'default', ttl: 60_000, limit: 120 }],
        storage,
      }),
    }),

    // Infrastructure
    DatabaseModule,
    StoreModule,
    /*
     * @Global(), like StoreModule: StoredFilesService is needed by identity, admin,
     * payments and compliance, and used to be provided by two of them and
     * re-exported by a third — more than one instance of a service that owns an S3
     * client, and a different answer per module to "where does this come from".
     */
    UploadsModule,
    EmailModule,
    NotificationsModule,
    SecurityModule,
    HealthModule,

    // Domain modules
    IdentityModule,
    PlatformsModule,
    CurrenciesModule,
    LeveragesModule,
    IbModule,
    WalletModule,
    TradingModule,
    PaymentsModule,
    ComplianceModule,
    SettingsModule,
    ProductsModule,
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
    // CsrfEchoMiddleware returns the caller's own anti-forgery token on every
    // response, because the frontends are on a different HOST from this API and
    // cannot read the cookie it is also set in. See the middleware.
    consumer.apply(RequestIdMiddleware, CsrfEchoMiddleware).forRoutes('*');
  }
}
