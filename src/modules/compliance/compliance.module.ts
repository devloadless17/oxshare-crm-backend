import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { KycController } from './kyc.controller';
import { UploadsController } from './uploads.controller';
import { KycService } from './kyc.service';
import { AdminAuthModule } from '../admin/admin-auth.module';
import { IdentityModule } from '../identity/identity.module';
import { WalletModule } from '../wallet/wallet.module';

@Module({
  // JwtModule registered here for UploadsController, which verifies both the
  // admin and client tokens itself (per-call secrets).
  //
  // WalletModule for `WalletProvisioningService`: approving a KYC submission is
  // what opens the client's wallets, one per enabled currency. No forwardRef
  // needed here — nothing in the wallet module depends on compliance.
  imports: [IdentityModule, JwtModule.register({}), AdminAuthModule, WalletModule],
  controllers: [KycController, UploadsController],
  providers: [KycService],
  exports: [KycService],
})
export class ComplianceModule {}
