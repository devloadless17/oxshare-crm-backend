import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { PassportModule } from '@nestjs/passport';
import { ConfigService } from '@nestjs/config';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { JwtStrategy } from './strategies/jwt.strategy';
import { JwtAuthGuard } from './guards/jwt-auth.guard';
import { KycVerifiedGuard } from './guards/kyc-verified.guard';
import { EmailVerifiedGuard } from './guards/email-verified.guard';
import { StoredFilesService } from '../../common/uploads/stored-files.service';

/*
 * STILL NO `forwardRef(() => WalletModule)`, and registration opens wallets again.
 *
 * The cycle existed because registration needed wallet while wallet needed
 * identity for `JwtAuthGuard`. The note left here asked the money rebuild to
 * prefer a listener over identity reaching in, because "a cycle is cheap to add
 * and expensive to notice".
 *
 * What it actually took was neither. `WalletProvisioningService` is provided by
 * the @Global `StoreModule`, so `AuthService` injects it without this module
 * importing anything — the same route it already takes to `IbStore` for
 * referral codes. `WalletModule` imports `IdentityModule` one way, for its
 * controller's guard, and the graph stays acyclic.
 *
 * An event bus would also have worked and was considered; it would have meant
 * adding `@nestjs/event-emitter` for one call site, which is a larger change
 * than the problem.
 */
@Module({
  imports: [
    PassportModule.register({ defaultStrategy: 'jwt' }),
    JwtModule.registerAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        secret: config.getOrThrow<string>('JWT_ACCESS_SECRET'),
        signOptions: { expiresIn: '15m' },
      }),
    }),
  ],
  controllers: [AuthController],
  providers: [
    AuthService,
    JwtStrategy,
    JwtAuthGuard,
    EmailVerifiedGuard,
    KycVerifiedGuard,
    // Shared with the KYC upload path — one definition of what is safe
    // to write to disk, rather than a second copy that drifts.
    StoredFilesService,
  ],
  exports: [AuthService, JwtAuthGuard, EmailVerifiedGuard, KycVerifiedGuard, StoredFilesService],
})
export class IdentityModule {}
