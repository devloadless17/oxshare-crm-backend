import { forwardRef, Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { PassportModule } from '@nestjs/passport';
import { ConfigService } from '@nestjs/config';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { JwtStrategy } from './strategies/jwt.strategy';
import { JwtAuthGuard } from './guards/jwt-auth.guard';
import { EmailVerifiedGuard } from './guards/email-verified.guard';
import { StoredFilesService } from '../../common/uploads/stored-files.service';
import { WalletModule } from '../wallet/wallet.module';

/*
 * ── The forwardRef, and why the cycle is real rather than sloppy ────────────
 *
 * WalletModule imports this one, for `JwtAuthGuard` on `WalletController`.
 * This one now needs WalletModule, for `WalletProvisioningService` — a client's
 * first wallet is opened during registration, and registration lives here.
 *
 * That is a genuine mutual dependency between two things that legitimately know
 * about each other: money endpoints need authentication, and signing up creates
 * money. The alternatives were considered and are worse — a third module
 * holding the provisioning service just moves the cycle one hop, and inlining
 * the wallet insert into `AuthService` would put a second, unlocked wallet
 * write outside `WalletService`, which §6.2 exists to prevent.
 *
 * `forwardRef` on BOTH sides is what Nest requires; one side alone throws at
 * boot. The injection point in `auth.service.ts` needs it too.
 */
@Module({
  imports: [
    forwardRef(() => WalletModule),
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
    // Shared with the KYC upload path — one definition of what is safe
    // to write to disk, rather than a second copy that drifts.
    StoredFilesService,
  ],
  exports: [AuthService, JwtAuthGuard, EmailVerifiedGuard, StoredFilesService],
})
export class IdentityModule {}
