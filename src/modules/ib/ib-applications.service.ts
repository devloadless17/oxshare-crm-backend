import { Inject, Injectable } from '@nestjs/common';
import { randomBytes } from 'node:crypto';
import { DRIZZLE_DB } from '../../database/database.module';
import type { Db } from '../../database/db';
import {
  IbStore,
  type IbAccountRow,
  type IbApplicationRow,
  type IbApplicationStatus,
} from '../../store/ib.store';
import { UsersStore } from '../../store/users.store';
import { IbLevelsService } from './ib-levels.service';
import { ClientVisibilityService } from '../../common/security/client-visibility.service';
import { EmailService } from '../email/email.service';
import type { ClientScope } from '../../common/security/client-scope';
import { ConflictError, NotFoundError, ValidationError } from '../../common/errors/domain-errors';

/**
 * The verification level a client must hold before they may apply.
 *
 * 1 is "KYC approved" — the same threshold that gated withdrawals. A partner
 * introduces other people to the platform and is paid for it, so the platform
 * has to know who they are first; taking an application from an unverified
 * account means a reviewer weighing a name nobody has checked.
 */
const REQUIRED_VERIFICATION_LEVEL = 1;

/**
 * Referral codes are drawn from an unambiguous alphabet.
 *
 * No 0/O, no 1/I/L. These get read off a screen, dictated over a phone and
 * typed into a registration form by somebody who is not the partner — a code
 * that is one glyph away from another person's is an attribution that silently
 * pays the wrong partner, and attribution is permanent per client.
 */
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const CODE_LENGTH = 8;

/**
 * Partner applications and the accounts they grant.
 *
 * ## Where the rules live
 *
 * All of them here, none in the controller (R-4.3). "Is this client verified
 * enough to apply", "does this parent have room for another partner", "would
 * this reassignment make a loop" are decisions about the domain, and a
 * controller that owned any of them would be a second place to look when the
 * answer surprises somebody.
 */
@Injectable()
export class IbApplicationsService {
  constructor(
    @Inject(DRIZZLE_DB) private readonly db: Db,
    private readonly ib: IbStore,
    private readonly users: UsersStore,
    private readonly levels: IbLevelsService,
    private readonly visibility: ClientVisibilityService,
    private readonly email: EmailService,
  ) {}

  // ── the client's side ──────────────────────────────────────────────────────

  /**
   * Everything the portal needs to decide which screen to render.
   *
   * Deliberately returns BOTH the account and the latest application. "Not a
   * partner" and "rejected two weeks ago with a reason" are different states,
   * and a client shown the blank application form after a refusal has been told
   * nothing about why. The portal's job is to render the difference; this
   * method's job is to make it available.
   */
  async statusFor(userId: string): Promise<{
    account: IbAccountRow | null;
    application: IbApplicationRow | null;
    eligible: boolean;
    /** Why not, in a sentence the portal can show verbatim. Null when eligible. */
    ineligibleReason: string | null;
  }> {
    const [account, application, user] = await Promise.all([
      this.ib.findAccount(userId),
      this.ib.findLatestByUser(userId),
      this.users.findById(userId),
    ]);

    const verified = (user?.verificationLevel ?? 0) >= REQUIRED_VERIFICATION_LEVEL;

    return {
      account: account ?? null,
      application: application ?? null,
      eligible: verified,
      ineligibleReason: verified
        ? null
        : 'Your identity must be verified before you can apply to the partner programme.',
    };
  }

  /**
   * Apply.
   *
   * The three refusals are ordered by what the client can DO about them: they
   * are already a partner (nothing to do), they already have one open (wait),
   * they are not verified (go and verify). Each says which.
   */
  async apply(
    userId: string,
    input: { motivation?: string; expectedVolume?: string; website?: string },
  ): Promise<IbApplicationRow> {
    const existingAccount = await this.ib.findAccount(userId);
    if (existingAccount) {
      throw new ConflictError('You are already a partner.');
    }

    const user = await this.users.findById(userId);
    if (!user) throw new NotFoundError('Account not found.');

    if (user.verificationLevel < REQUIRED_VERIFICATION_LEVEL) {
      throw new ValidationError(
        'Your identity must be verified before you can apply to the partner programme.',
      );
    }

    /*
     * The advisory half of "one pending application per client".
     *
     * `ib_applications_one_pending_uq` is what actually enforces it — this read
     * loses to a double-submit and is here only to produce a sentence better
     * than a constraint-violation error. If the two disagree the database wins,
     * and the catch below is what turns its refusal back into that same
     * sentence.
     */
    const pending = await this.ib.findPendingByUser(userId);
    if (pending) {
      throw new ConflictError('You already have an application awaiting review.');
    }

    try {
      return await this.ib.createApplication({
        userId,
        motivation: input.motivation ?? null,
        expectedVolume: input.expectedVolume ?? null,
        website: input.website ?? null,
      });
    } catch (error) {
      if (violates(error, 'ib_applications_one_pending_uq')) {
        throw new ConflictError('You already have an application awaiting review.');
      }
      throw error;
    }
  }

  // ── the reviewer's side ────────────────────────────────────────────────────

  /**
   * The review queue.
   *
   * `scope` is the reviewing admin's client visibility, applied in the query
   * rather than filtered afterwards. An admin limited to a subset of clients
   * must not see a partner application from outside it, and the per-status
   * counts are scoped identically — a count that ignored visibility would
   * promise twelve pending applications and then show four.
   */
  list(
    filter: { status?: IbApplicationStatus; page?: number; limit?: number },
    scope: ClientScope,
  ) {
    const page = Math.max(1, filter.page ?? 1);
    const limit = Math.min(100, Math.max(1, filter.limit ?? 20));
    return this.ib.findPageWithUsers({ status: filter.status, page, limit, scope });
  }

  /**
   * Approve an application and create the partner account, atomically.
   *
   * ## One transaction, and a CONDITIONAL write
   *
   * `transition` puts `status = 'pending'` in the WHERE clause, so the check
   * and the write are a single statement. Two admins racing approve against
   * reject cannot both pass a check against the same row: the second finds
   * nothing to update and is refused. Without the transaction there is a state
   * where the application says approved and no account exists — a partner who
   * has been told they were accepted and has no referral code.
   *
   * The pre-reads above it are advisory, for precise messages only.
   */
  async approve(
    applicationId: string,
    reviewerId: string,
    scope: ClientScope,
    options: { level?: number; parentIbUserId?: string | null } = {},
  ): Promise<IbAccountRow> {
    const application = await this.ib.findById(applicationId);
    if (!application) throw new NotFoundError('Application not found.');
    /*
     * The by-id half of client scope. The list query filters with a predicate;
     * a route that names an application in its PATH has nowhere for that
     * predicate to live, so the question is asked first. It 404s rather than
     * 403s — a 403 would confirm the id names a real application, which is an
     * enumeration oracle for the exact clients this admin was denied.
     */
    await this.visibility.assertVisible(application.userId, scope);
    if (application.status !== 'pending') {
      throw new ConflictError(
        `Only a pending application can be approved; this one is ${application.status}.`,
      );
    }

    const level = await this.resolveLevel(options.level, options.parentIbUserId ?? null);
    const parentIbUserId = options.parentIbUserId ?? null;

    if (parentIbUserId) {
      await this.assertParentHasRoom(parentIbUserId);
    }

    const referralCode = await this.generateReferralCode();

    const account = await this.db.transaction(async (tx) => {
      const updated = await this.ib.transition(
        applicationId,
        ['pending'],
        {
          status: 'approved',
          reviewedBy: reviewerId,
          reviewedAt: new Date(),
        },
        tx,
      );
      if (!updated) {
        throw new ConflictError(
          'This application was changed by another reviewer. Reload and try again.',
        );
      }

      return this.ib.createAccount(
        {
          userId: application.userId,
          level,
          parentIbUserId,
          referralCode,
          applicationId,
        },
        tx,
      );
    });

    /*
     * AFTER the transaction, and fire-and-forget.
     *
     * Inside it, a slow SMTP server would hold a write lock on the application
     * row for as long as the handshake took, and a mail failure would roll back
     * an approval that was correct. Awaited, a client waits on delivery to see
     * their referral code.
     *
     * The trade is that a bounced email leaves an approved partner who was not
     * told. That is recoverable — the portal shows the same code the moment
     * they look — where an approval lost to a mail outage is not.
     * EmailService logs the failure with recipient and reason, never the code.
     */
    void this.notifyDecision(application.userId, 'approved', { referralCode });

    return account;
  }

  /**
   * The decision email, looked up and sent without ever failing the decision.
   *
   * Private and shared by both paths so approve and reject cannot drift into
   * sending different things — and so the `void` is in exactly one place, which
   * is where somebody reading this should have to think about it.
   */
  private async notifyDecision(
    userId: string,
    decision: 'approved' | 'rejected',
    options: { referralCode?: string; reason?: string },
  ): Promise<void> {
    const user = await this.users.findById(userId);
    if (!user) return;
    await this.email.sendPartnerDecisionEmail(user.email, user.firstName, decision, options);
  }

  /**
   * Reject, with a reason the client will actually be shown.
   *
   * The reason is REQUIRED and composed here rather than assembled by the
   * frontend, matching how a KYC refusal is built: a configured label,
   * optionally suffixed with the reviewer's note. Refusing an empty reason is
   * the point — "rejected" with no explanation is the outcome this whole field
   * exists to prevent.
   */
  async reject(
    applicationId: string,
    reviewerId: string,
    scope: ClientScope,
    input: { reason?: string; note?: string },
  ): Promise<IbApplicationRow> {
    const reason = composeReason(input.reason, input.note);

    const application = await this.ib.findById(applicationId);
    if (!application) throw new NotFoundError('Application not found.');
    await this.visibility.assertVisible(application.userId, scope);
    if (application.status !== 'pending') {
      throw new ConflictError(
        `Only a pending application can be rejected; this one is ${application.status}.`,
      );
    }

    const updated = await this.ib.transition(applicationId, ['pending'], {
      status: 'rejected',
      rejectionReason: reason,
      reviewedBy: reviewerId,
      reviewedAt: new Date(),
    });
    if (!updated) {
      throw new ConflictError(
        'This application was changed by another reviewer. Reload and try again.',
      );
    }

    // The composed sentence, not the parts — the client reads the same text the
    // portal shows them, so the two can never disagree.
    void this.notifyDecision(application.userId, 'rejected', { reason });

    return updated;
  }

  // ── managing partners after approval ───────────────────────────────────────

  /** The partner list, scoped to what this admin may see. */
  listPartners(filter: { page?: number; limit?: number }, scope: ClientScope) {
    const page = Math.max(1, filter.page ?? 1);
    const limit = Math.min(100, Math.max(1, filter.limit ?? 20));
    return this.ib.findPartnersPage({ page, limit, scope });
  }

  /**
   * Move a partner to a different rung.
   *
   * The level must be ENABLED: a disabled level takes no share, so placing
   * somebody on one is a silent stop to their earnings rather than a demotion
   * they could see.
   */
  async changeLevel(userId: string, level: number, scope: ClientScope): Promise<IbAccountRow> {
    await this.visibility.assertVisible(userId, scope);

    const account = await this.ib.findAccount(userId);
    if (!account) throw new NotFoundError('That partner does not exist.');

    const enabled = await this.levels.listEnabled();
    if (!enabled.some((l) => l.level === level)) {
      throw new ValidationError(
        `Level ${level} is not an enabled partner level. Enabled levels: ${enabled
          .map((l) => l.level)
          .join(', ')}.`,
      );
    }

    const updated = await this.ib.updateAccount(userId, { level });
    if (!updated) throw new NotFoundError('That partner does not exist.');
    return updated;
  }

  /**
   * Reassign a partner's parent, or cut them loose to deal direct.
   *
   * ## The cycle check is the whole point of this method
   *
   * A self-referencing foreign key checks only that the target row exists, so
   * Postgres accepts A→B→A — `test/ib-schema-constraints.spec.ts` asserts that
   * gap deliberately. The payout walk climbs parents until it runs out, and a
   * loop is a walk that never does. This is the only thing standing between an
   * operator's drop-down and a hung commission calculation.
   *
   * `maxDirectPartners` is checked too, because a reassignment fills a slot on
   * the new parent exactly as an approval would.
   */
  async reassignParent(
    userId: string,
    parentIbUserId: string | null,
    scope: ClientScope,
  ): Promise<IbAccountRow> {
    await this.visibility.assertVisible(userId, scope);

    const account = await this.ib.findAccount(userId);
    if (!account) throw new NotFoundError('That partner does not exist.');

    if (parentIbUserId) {
      if (await this.wouldCreateCycle(userId, parentIbUserId)) {
        throw new ValidationError(
          'That partner already sits beneath this one, so the change would create a loop in the ' +
            'payout chain.',
        );
      }
      await this.assertParentHasRoom(parentIbUserId);
    }

    const updated = await this.ib.updateAccount(userId, { parentIbUserId });
    if (!updated) throw new NotFoundError('That partner does not exist.');
    return updated;
  }

  /**
   * Suspend or reactivate.
   *
   * A suspended partner keeps their referral code and their tree — clients
   * attributed to them stay attributed — and stops earning. Deleting the row
   * instead would orphan everybody beneath them, which is why there is no
   * "remove partner" here at all.
   */
  async setActive(userId: string, active: boolean, scope: ClientScope): Promise<IbAccountRow> {
    await this.visibility.assertVisible(userId, scope);

    const updated = await this.ib.updateAccount(userId, { active });
    if (!updated) throw new NotFoundError('That partner does not exist.');
    return updated;
  }

  // ── placement rules ────────────────────────────────────────────────────────

  /**
   * Which rung a new partner lands on.
   *
   * With no parent they are dealing with the broker directly, so they go to the
   * shallowest enabled level. With a parent they go one below the parent's —
   * that IS what the hierarchy means — and the ladder's depth is the limit: a
   * partner placed below the deepest enabled level would never be paid,
   * because no level exists to pay them.
   */
  private async resolveLevel(explicit: number | undefined, parentIbUserId: string | null) {
    const enabled = await this.levels.listEnabled();
    if (enabled.length === 0) {
      throw new ValidationError(
        'No partner levels are enabled, so no partner can be approved. Enable a level first.',
      );
    }

    if (explicit !== undefined) {
      const chosen = enabled.find((l) => l.level === explicit);
      if (!chosen) {
        throw new ValidationError(
          `Level ${explicit} is not an enabled partner level. Enabled levels: ${enabled
            .map((l) => l.level)
            .join(', ')}.`,
        );
      }
      return chosen.level;
    }

    if (!parentIbUserId) return enabled[0].level;

    const parent = await this.ib.findAccount(parentIbUserId);
    if (!parent) throw new ValidationError('The chosen parent partner does not exist.');

    const below = enabled.find((l) => l.level > parent.level);
    if (!below) {
      throw new ValidationError(
        `The partner ladder is ${enabled.length} level(s) deep and this parent is already at the ` +
          'deepest enabled level, so a partner beneath them would never earn. Add a level or ' +
          'choose a different parent.',
      );
    }
    return below.level;
  }

  /** `maxDirectPartners`, enforced at the moment a parent is assigned. */
  private async assertParentHasRoom(parentIbUserId: string): Promise<void> {
    const parent = await this.ib.findAccount(parentIbUserId);
    if (!parent) throw new ValidationError('The chosen parent partner does not exist.');
    if (!parent.active) {
      throw new ValidationError('The chosen parent partner is suspended.');
    }

    const level = await this.levels.findOne(parent.level);
    const max = level?.maxDirectPartners ?? null;
    if (max === null) return;

    const held = await this.ib.countDirectPartners(parentIbUserId);
    if (held >= max) {
      throw new ValidationError(
        `That partner already holds ${held} of their ${max} direct partners. Choose a different ` +
          'parent or raise the limit on their level.',
      );
    }
  }

  /**
   * Would making `parentIbUserId` the parent of `userId` create a loop?
   *
   * Public because the reassign action on the partners list needs it, and it is
   * the guard the DATABASE cannot provide: a self-referencing foreign key
   * checks only that the target row exists, so A→B→A is accepted by Postgres.
   * `test/ib-schema-constraints.spec.ts` asserts that gap on purpose, so this
   * is understood as load-bearing rather than defensive.
   *
   * A cycle is not a cosmetic problem: the payout walk climbs parents until it
   * runs out, and a loop is a walk that never does.
   */
  async wouldCreateCycle(userId: string, parentIbUserId: string): Promise<boolean> {
    if (userId === parentIbUserId) return true;
    // If the proposed parent already sits BENEATH this partner, pointing at
    // them closes the ring.
    const ancestorsOfParent = await this.ib.ancestorsOf(parentIbUserId);
    return ancestorsOfParent.includes(userId);
  }

  /**
   * A code nobody else holds.
   *
   * Retried rather than trusted: 31^8 is large, but the column is UNIQUE and a
   * collision would surface as a failed approval at the worst possible moment.
   * The loop is bounded — an unbounded retry on a saturated keyspace is a hung
   * request — and exhausting it is a real error rather than a silently reused
   * code, because attribution is permanent and a duplicate pays the wrong
   * partner forever.
   */
  private async generateReferralCode(): Promise<string> {
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const code = randomCode();
      const taken = await this.ib.findAccountByReferralCode(code);
      if (!taken) return code;
    }
    throw new ConflictError('Could not allocate a referral code. Please try again.');
  }
}

/**
 * `randomBytes`, not `Math.random`.
 *
 * A referral code is not a secret, but it is an identifier somebody could
 * enumerate to map the partner network, and a CSPRNG costs nothing here.
 * Modulo bias is avoided by the alphabet length dividing evenly enough that the
 * skew is immaterial at this size — and the code is checked for uniqueness
 * regardless.
 */
function randomCode(): string {
  const bytes = randomBytes(CODE_LENGTH);
  let out = '';
  for (const byte of bytes) out += CODE_ALPHABET[byte % CODE_ALPHABET.length];
  return out;
}

/**
 * The refusal the client is shown, built from the reviewer's inputs.
 *
 * Both parts optional individually, at least one required together — a
 * rejection with nothing in it tells the client only that the answer was no.
 * The note is appended rather than replacing the label so the reason stays
 * comparable across reviewers while still allowing the specific detail.
 */
function composeReason(reason?: string, note?: string): string {
  const label = reason?.trim() ?? '';
  const extra = note?.trim() ?? '';

  if (!label && !extra) {
    throw new ValidationError('A rejection needs a reason. Choose one, or write a note.');
  }
  if (!label) return extra;
  if (!extra) return label;
  return `${label} — ${extra}`;
}

/** Did this error come from a specific named constraint? */
function violates(error: unknown, constraint: string): boolean {
  const cause: unknown = (error as { cause?: unknown }).cause ?? error;
  return (cause as { constraint?: string })?.constraint === constraint;
}
