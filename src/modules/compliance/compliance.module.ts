import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { KycController } from './kyc.controller';
import { UploadsController } from './uploads.controller';
import { KycService } from './kyc.service';
import { IdentityModule } from '../identity/identity.module';

@Module({
  // JwtModule registered here for UploadsController, which verifies both the
  // admin and client tokens itself (per-call secrets).
  imports: [IdentityModule, JwtModule.register({})],
  controllers: [KycController, UploadsController],
  providers: [KycService],
  exports: [KycService],
})
export class ComplianceModule {}
