import { Module } from '@nestjs/common';
import { KycController } from './kyc.controller';
import { UploadsController } from './uploads.controller';
import { KycService } from './kyc.service';
import { IdentityModule } from '../identity/identity.module';

@Module({
  imports: [IdentityModule],
  controllers: [KycController, UploadsController],
  providers: [KycService],
  exports: [KycService],
})
export class ComplianceModule {}
