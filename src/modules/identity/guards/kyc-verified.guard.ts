import { CanActivate, ExecutionContext, Inject, Injectable } from '@nestjs/common';
import { UsersStore } from '../../../store/users.store';
import { KycNotVerifiedError } from '../../../common/errors/domain-errors';

/**
 * The verification level a client must hold to move money.
 *
 * 1 is "KYC approved", set in exactly one place — `KycService.approve()` — and
 * taken back to 0 by `reject()`. Named rather than inlined so the two services
 * that also check it (`IbApplicationsService`, and the money services below)
 * cannot drift to a different number.
 */
export const REQUIRED_VERIFICATION_LEVEL = 1;

/**
 * Refuses a money movement from a client whose identity is not verified.
 *
 * ## Why this exists as a guard at all
 *
 * There was no such guard before this. The only enforcement of level 1 was an
 * inline check inside one service, which meant every new money route had to
 * remember to write its own — and a route that forgot looked exactly like a
 * route that did not need one.
 *
 * ## It does NOT replace the service checks
 *
 * `TransactionsService.requestWithdrawal` and `TransfersService.request` each
 * re-read the level and refuse it themselves. That is deliberate duplication,
 * not an oversight: R-4.3 puts authorization in services because a service is
 * reachable from a job, a webhook or another service — none of which pass
 * through a guard. This is the cheap early refusal that keeps an unverified
 * client from filling in a form the API was always going to reject; the service
 * check is the one that is actually load-bearing.
 *
 * ## It reads the DATABASE, not the token
 *
 * `verificationLevel` is on the JWT payload at sign-in time and is stale the
 * moment a reviewer approves or rejects somebody. A client approved five
 * minutes ago holds a token saying 0, and one rejected five minutes ago holds a
 * token saying 1 — the second is the dangerous direction, because it authorises
 * a withdrawal from an account whose approval has been withdrawn. The extra
 * read is one indexed lookup on a route that is about to open a transaction
 * anyway.
 *
 * This is the same lesson `proxy.ts` records in the portal: a guard that reads
 * a claim is coupled to which token it was handed, and nothing makes that
 * coupling visible.
 */
@Injectable()
export class KycVerifiedGuard implements CanActivate {
  constructor(@Inject(UsersStore) private readonly users: UsersStore) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<{ user?: { id: number } }>();
    const userId = request.user?.id;

    /*
     * No session is not this guard's refusal to make. `JwtAuthGuard` runs first
     * and answers 401; reaching here without a user means the route was
     * mis-wired, and answering 403 would report the wrong problem.
     */
    if (!userId) {
      throw new KycNotVerifiedError('Your identity must be verified before you can do this.');
    }

    const user = await this.users.findById(userId);
    if ((user?.verificationLevel ?? 0) < REQUIRED_VERIFICATION_LEVEL) {
      /*
       * One message for every reason — not yet started, submitted, under
       * review, rejected. The portal knows the client's KYC status from
       * `/kyc/status` and renders the state properly; this refusal only has to
       * be unambiguous and carry a code the portal can branch on.
       */
      throw new KycNotVerifiedError(
        'Your identity must be verified before you can move money. Complete verification to continue.',
      );
    }

    return true;
  }
}
