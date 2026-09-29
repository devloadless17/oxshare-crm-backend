import { Global, Injectable, Module } from '@nestjs/common';
import type { Executor } from '../../database/db';
import {
  IDENTITY_REVIEW,
  type IdentityReviewPort,
  type IdentityReviewStanding,
  type IdentityReviewState,
} from '../../common/provisioning/identity-review.port';
import { VERIFICATION_REQUIRED } from '../../common/kyc/identity-core';
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
    userId: number,
    executor: Executor,
  ): Promise<IdentityReviewState | undefined> {
    const submission = await this.kyc.lockForUpdate(userId, executor);
    return submission
      ? { status: submission.status, returnedItems: submission.rejectedFields ?? [] }
      : undefined;
  }

  async keepReturned(userId: number, remaining: string[], executor: Executor): Promise<void> {
    await this.kyc.update(userId, { rejectedFields: remaining }, executor);
  }

  async standingOf(userId: number): Promise<IdentityReviewStanding> {
    const submission = await this.kyc.findByUserId(userId);
    if (submission?.status !== 'approved') {
      return { status: submission?.status, verifiedRequired: [] };
    }
    /*
     * What the approval was judged against: the requirements recorded when the
     * client submitted (0158). An approval with none on record predates them,
     * and the platform's fixed tier is what it was judged by.
     */
    const policy = submission.formPolicy;
    return {
      status: submission.status,
      verifiedRequired: policy
        ? policy.identity.filter((detail) => detail.required).map((detail) => detail.name)
        : VERIFICATION_REQUIRED,
    };
  }
}

/** Global, so the global profile module can inject the port it declares. */
@Global()
@Module({
  providers: [KycIdentityReview, { provide: IDENTITY_REVIEW, useExisting: KycIdentityReview }],
  exports: [IDENTITY_REVIEW],
})
export class KycIdentityReviewModule {}
