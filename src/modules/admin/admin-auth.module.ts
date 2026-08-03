import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { ConfigModule, ConfigService } from '@nestjs/config';
import {
  AdminAuthenticator,
  AdminGuard,
  MasterAdminGuard,
  PermissionsGuard,
} from './guards/admin.guard';

const PROVIDERS = [AdminAuthenticator, AdminGuard, MasterAdminGuard, PermissionsGuard];

/**
 * The admin guards, on their own so any module can use them.
 *
 * They cannot live in AdminModule: AdminModule imports ComplianceModule, and
 * ComplianceModule's controllers use these guards — importing back would be a
 * cycle. A guard referenced by @UseGuards must be resolvable from the host
 * controller's module, so the guards belong in a leaf module both can import.
 */
@Module({
  imports: [
    ConfigModule,
    JwtModule.registerAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        secret: config.getOrThrow<string>('ADMIN_JWT_SECRET'),
        signOptions: { expiresIn: '8h' },
      }),
    }),
  ],
  providers: PROVIDERS,
  exports: [...PROVIDERS, JwtModule],
})
export class AdminAuthModule {}
