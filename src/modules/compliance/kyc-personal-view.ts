import type { KycSubmission } from '../../store/kyc.store';
import type { User } from '../../store/users.store';
import { isProfileKey } from '../../common/profile/client-profile';
import { profileOf } from '../profile/client-profile.service';

/** The answers that are NOT profile fields — what `personal_info` may store. */
export function customAnswersOf(
  answers: Record<string, string> | undefined,
): Record<string, string> {
  return Object.fromEntries(Object.entries(answers ?? {}).filter(([key]) => !isProfileKey(key)));
}

/**
 * The submission, with its personal step read as ONE record — what every
 * reader (the client's status and the desk's review alike) sees.
 *
 * The client's whole profile, and the stored answers to the questions a
 * broker added. Before 0139 the step kept its own copy of the name, phone and
 * country, so a client could hold one name on their account and another on
 * their verification, and the review screen printed both. Now there is one
 * value, and it is the profile's — all nine fields, whatever the builder
 * shows, because the identity is the platform's (26 Sep 2026).
 */
export function withPersonalView(submission: KycSubmission, user: User | undefined): KycSubmission {
  return {
    ...submission,
    personalInfo: { ...customAnswersOf(submission.personalInfo), ...(user ? profileOf(user) : {}) },
  };
}
