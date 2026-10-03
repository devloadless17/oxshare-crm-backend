import { Module } from '@nestjs/common';
import { KycController } from './kyc.controller';
import { UploadsController } from './uploads.controller';
import { KycClientService } from './kyc-client.service';
import { KycReviewService } from './kyc-review.service';
import { KycDocumentAccess } from './kyc-document-access.service';
import { PaymentsModule } from '../payments/payments.module';
import { AdminAuthModule } from '../admin/admin-auth.module';
import { IdentityModule } from '../identity/identity.module';

@Module({
  // UploadsController authenticates through the SAME objects the guards use —
  // `AdminAuthenticator` + `IpAllowlistGuard` (AdminAuthModule) and
  // `JwtStrategy` (IdentityModule) — and asks each bucket's owning module who
  // may read it (`KycDocumentAccess` here, `DepositReceiptAccess` in payments).
  imports: [IdentityModule, AdminAuthModule, PaymentsModule],
  controllers: [KycController, UploadsController],
  providers: [KycClientService, KycReviewService, KycDocumentAccess],
  exports: [KycReviewService],
})
export class ComplianceModule {}
