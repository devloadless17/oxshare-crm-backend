import { Global, Injectable, Module } from '@nestjs/common';
import type { Executor } from '../../database/db';
import {
  IDENTITY_REVIEW,
  type IdentityReviewPort,
  type IdentityReviewState,
} from '../../common/provisioning/identity-review.port';
import { KycStore } from '../../store/kyc.store';

/**
 * The manual KYC review, answering the identity core's questions about it
 * (`IDENTITY_REVIEW`). An external verification tool would provide the same
 * port from its own state; the core would not change.
 */
@Injectable()
export class KycIdentityReview implements IdentityReviewPort {
  constructor(private readonly kyc: KycStore) {}

  async lockForChange(
    userId: string,
    executor: Executor,
  ): Promise<IdentityReviewState | undefined> {
    const submission = await this.kyc.lockForUpdate(userId, executor);
    return submission
      ? { status: submission.status, returnedItems: submission.rejectedFields ?? [] }
      : undefined;
  }

  async keepReturned(userId: string, remaining: string[], executor: Executor): Promise<void> {
    await this.kyc.update(userId, { rejectedFields: remaining }, executor);
  }

  async statusOf(userId: string): Promise<string | undefined> {
    return (await this.kyc.findByUserId(userId))?.status;
  }
}

/** Global, so the global profile module can inject the port it declares. */
@Global()
@Module({
  providers: [KycIdentityReview, { provide: IDENTITY_REVIEW, useExisting: KycIdentityReview }],
  exports: [IDENTITY_REVIEW],
})
export class KycIdentityReviewModule {}
