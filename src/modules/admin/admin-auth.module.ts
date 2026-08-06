import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { ConfigModule, ConfigService } from '@nestjs/config';
import {
  AdminAuthenticator,
  AdminGuard,
  MasterAdminGuard,
  PermissionsGuard,
} from './guards/admin.guard';
import { ClientFieldsService } from './client-fields.service';
import { AdminAuditService } from './admin-audit.service';

/**
 * `ClientFieldsService` sits here, not in AdminModule, because
 * `AdminAuthenticator` resolves the field mask on every authenticated request
 * and a guard's dependencies have to be resolvable from this leaf module. It
 * has no dependencies of its own — a cached JSON file — so it introduces no
 * cycle.
 */
const PROVIDERS = [
  AdminAuthenticator,
  AdminGuard,
  MasterAdminGuard,
  PermissionsGuard,
  ClientFieldsService,
  /*
   * `AdminAuditService` is here for the same reason as the guards: this is the
   * leaf module every other one can import without a cycle, and the audit
   * writer is now needed OUTSIDE `AdminModule` — `PlatformsModule` records
   * changes to the download links the portal serves to clients.
   *
   * It depends only on two @Global() stores, so it costs nothing to place here
   * and avoids `PlatformsModule` importing `AdminModule`, which imports four
   * feature modules and would make an audit line a reason for a dependency
   * cycle.
   */
  AdminAuditService,
];

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
        // No signOptions default. Both auth services pass `expiresIn` explicitly, and
        // the `8h` that used to sit here was a leftover from the pre-R-3.3 admin
        // access token — inert today, and silently wrong for the next `jwt.sign()`
        // anybody adds in this module.
      }),
    }),
  ],
  providers: PROVIDERS,
  exports: [...PROVIDERS, JwtModule],
})
export class AdminAuthModule {}
