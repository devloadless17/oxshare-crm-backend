import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { PassportModule } from '@nestjs/passport';
import { ConfigService } from '@nestjs/config';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { JwtStrategy } from './strategies/jwt.strategy';
import { JwtAuthGuard } from './guards/jwt-auth.guard';
import { EmailVerifiedGuard } from './guards/email-verified.guard';
import { StoredFilesService } from '../../common/uploads/stored-files.service';

/*
 * The `forwardRef(() => WalletModule)` that used to sit here is gone with the
 * money teardown, and with it the only module cycle in the backend.
 *
 * It existed because registration opened a client's first wallet, so identity
 * needed wallet while wallet needed identity for `JwtAuthGuard`. That was a
 * genuine mutual dependency rather than sloppiness — but it is also the kind of
 * thing worth NOT recreating by reflex. When the money rebuild lands, prefer
 * having the money module listen for a registration event over having identity
 * reach into it; a cycle is cheap to add and expensive to notice.
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
    // Shared with the KYC upload path — one definition of what is safe
    // to write to disk, rather than a second copy that drifts.
    StoredFilesService,
  ],
  exports: [AuthService, JwtAuthGuard, EmailVerifiedGuard, StoredFilesService],
})
export class IdentityModule {}
