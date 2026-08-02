import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import { AdminController } from './admin.controller';
import { AdminService } from './admin.service';
import { AdminGuard, MasterAdminGuard } from './guards/admin.guard';
import { ComplianceModule } from '../compliance/compliance.module';

@Module({
  imports: [
    ComplianceModule,
    JwtModule.registerAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        secret: config.get<string>('ADMIN_JWT_SECRET', 'oxshare-admin-secret-dev'),
        signOptions: { expiresIn: '8h' },
      }),
    }),
  ],
  controllers: [AdminController],
  providers: [AdminService, AdminGuard, MasterAdminGuard],
  exports: [AdminService],
})
export class AdminModule {}
