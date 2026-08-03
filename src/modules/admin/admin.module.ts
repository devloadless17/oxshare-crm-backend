import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import { AdminController } from './admin.controller';
import { AdminService } from './admin.service';
import { AdminGuard, MasterAdminGuard, PermissionsGuard } from './guards/admin.guard';
import { ComplianceModule } from '../compliance/compliance.module';
import { PaymentsModule } from '../payments/payments.module';
import { WalletModule } from '../wallet/wallet.module';
import { PartnersModule } from '../partners/partners.module';

@Module({
  imports: [
    ComplianceModule,
    PaymentsModule,
    WalletModule,
    PartnersModule,
    JwtModule.registerAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        secret: config.get<string>('ADMIN_JWT_SECRET', 'oxshare-admin-secret-dev'),
        signOptions: { expiresIn: '8h' },
      }),
    }),
  ],
  controllers: [AdminController],
  providers: [AdminService, AdminGuard, MasterAdminGuard, PermissionsGuard],
  exports: [AdminService],
})
export class AdminModule {}
