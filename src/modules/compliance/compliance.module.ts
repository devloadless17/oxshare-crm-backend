import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { KycController } from './kyc.controller';
import { UploadsController } from './uploads.controller';
import { KycService } from './kyc.service';
import { AdminAuthModule } from '../admin/admin-auth.module';
import { IdentityModule } from '../identity/identity.module';

@Module({
  // JwtModule registered here for UploadsController, which verifies both the
  // admin and client tokens itself (per-call secrets).
  //
  // WalletModule used to be imported here so KYC approval could open a client's
  // wallets. It went with the money teardown; approval no longer has a money
  // side effect, and the rebuild will decide where wallet provisioning belongs.
  imports: [IdentityModule, JwtModule.register({}), AdminAuthModule],
  controllers: [KycController, UploadsController],
  providers: [KycService],
  exports: [KycService],
})
export class ComplianceModule {}
