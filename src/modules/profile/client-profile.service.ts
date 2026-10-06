import { Inject, Injectable } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import { DRIZZLE_DB } from '../../database/database.module';
import type { Db, Executor } from '../../database/db';
import { users } from '../../database/schema';
import {
  ConflictError,
  FieldValidationError,
  KycCorrectionRefusedError,
  NotFoundError,
  ProfileLockedError,
  ValidationError,
  PhoneAlreadyRegisteredError,
} from '../../common/errors/domain-errors';
import { violatesConstraint } from '../../common/errors/pg-violation';
import {
  adminEditRule,
  checkProfile,
  offeredProblems,
  firstProfileError,
  isProfileKey,
  normaliseProfileValue,
  PROFILE_FIELD_KEYS,
  type ClientProfile,
  type ProfileKey,
} from '../../common/profile/client-profile';
import { identityField } from '../../common/kyc/identity-core';
import { pickLocalized } from '../../common/i18n/locale';
import { AuditLogStore, type AuditSubjectType } from '../../store/audit-log.store';
import {
  IDENTITY_REVIEW,
  type IdentityReviewPort,
} from '../../common/provisioning/identity-review.port';
import { EmailService } from '../email/email.service';
import { OfferedCountriesStore } from '../../store/offered-countries.store';
import { UsersStore, type User } from '../../store/users.store';

/** Who is changing a profile — every change is recorded against somebody. */
export interface ProfileActor {
  kind: 'client' | 'admin' | 'system';
  /** An admin's uuid, or a client's Portal ID (0159). */
  id: string | number;
  email: string;
}

/**
 * The audit row a change writes. Defaults to `client.profile_update` on the
 * client's record; the KYC correction route keeps its own action and subject,
 * which investigators already filter by.
 */
export interface ProfileAuditOptions {
  action?: string;
  subjectType?: AuditSubjectType;
  subjectId?: string | number;
  /** Where the change came from — `kyc`, `admin_edit`, `kyc_correction`. */
  via?: string;
  /** Why — a reviewer's correction of a verified record must say. */
  reason?: string;
}

/** A user's profile as the API speaks it — blank fields absent, never "". */
export function profileOf(user: User): ClientProfile {
  const out: ClientProfile = {};
  for (const key of PROFILE_FIELD_KEYS) {
    const value = user[key];
    if (typeof value === 'string' && value !== '') out[key] = value;
  }
  return out;
}

/**
 * THE ONE WRITE PATH FOR A CLIENT'S IDENTITY.
 *
 * Registration seeds the profile; after that every change — the client in the
 * KYC personal step, the support desk's edit, a reviewer's correction — comes
 * through `update`, which:
 *
 *  1. checks and normalises the values by `common/profile/client-profile.ts`,
 *     refusing field by field (`FieldValidationError` → `fields` in the 400);
 *  2. locks the client's KYC submission, THEN their profile row — see below;
 *  3. writes ONLY what actually changed, compared after normalisation — so
 *     "+961 70 123 456" re-typed over "+96170123456" is no change at all —
 *     after the caller's `guard` has seen exactly those fields and the
 *     verification's state, and not refused them;
 *  4. records who changed what, before → after, in the SAME transaction as the
 *     write. A profile change without its audit row cannot exist.
 *
 * There is deliberately no other way to write these columns from a request —
 * `UsersStore.update` refuses them, by type and at runtime. Two write paths is
 * how a client ended up with two names.
 *
 * ## Why the KYC row is locked first
 *
 * Whether a field may change depends on the verification: nothing a reviewer is
 * checking may move under them. Submission judges the profile and moves the
 * status under that same row lock (`KycClientService.submit`), so holding it here
 * means a profile write and a submission can never interleave — one finishes
 * before the other reads. And it is the order approval takes the two rows in
 * (the submission, then the client's level), so no pair of writers can
 * deadlock by taking them the other way round.
 */
@Injectable()
export class ClientProfileService {
  constructor(
    @Inject(DRIZZLE_DB) private readonly db: Db,
    private readonly users: UsersStore,
    private readonly auditLog: AuditLogStore,
    /*
     * Where the client's review stands, asked through a PORT the verification
     * process provides — the core never reads the KYC tables itself, so KYC
     * can be replaced without touching it.
     */
    @Inject(IDENTITY_REVIEW) private readonly review: IdentityReviewPort,
    // The countries the broker offers (0178): a NEW country or nationality must be one.
    private readonly offered: OfferedCountriesStore,
    // Last, and optional: two specs construct this by hand, and only a
    // correction sends mail.
    private readonly email?: EmailService,
  ) {}

  /**
   * Change a client's profile. `input` holds only the fields being written; a
   * blank one is cleared (names never are). Returns the user as stored and the
   * fields that actually moved.
   */
  async update(
    userId: number,
    input: Partial<Record<ProfileKey, unknown>>,
    actor: ProfileActor,
    options: {
      required?: readonly ProfileKey[];
      /**
       * The audit row — or how to choose it from what ACTUALLY changed, under
       * the locks: a desk edit that touches a verified detail is a correction,
       * one that only moves the phone is not.
       */
      audit?:
        | ProfileAuditOptions
        | ((
            changed: readonly ProfileKey[],
            verification: string | undefined,
          ) => ProfileAuditOptions);
      executor?: Executor;
      asOf?: Date;
      /**
       * The caller's policy, asked with the fields that would ACTUALLY change
       * and the verification's status, both read under the locks. Throw to
       * refuse; nothing is written. Unchanged values never reach it, so a form
       * that sends back a locked field untouched is not refused for it.
       */
      guard?: (changed: readonly ProfileKey[], verification: string | undefined) => void;
    } = {},
  ): Promise<{
    user: User;
    before: ClientProfile;
    after: ClientProfile;
    changed: ProfileKey[];
    verification: string | undefined;
  }> {
    const check = checkProfile(input, { required: options.required, asOf: options.asOf });
    const message = firstProfileError(check.errors);
    if (message) {
      throw new FieldValidationError(message, check.errors);
    }

    const run = async (tx: Executor) => {
      const submission = await this.review.lockForChange(userId, tx);
      const verification = submission?.status;
      const current = await this.users.findByIdForUpdate(userId, tx);
      if (!current) throw new NotFoundError('Client not found.');

      const before: ClientProfile = {};
      const after: ClientProfile = {};
      // A profile field IS its column's name (0139), so the keys write through.
      const changes: Partial<Pick<typeof users.$inferInsert, ProfileKey>> = {};
      const changed: ProfileKey[] = [];
      for (const key of PROFILE_FIELD_KEYS) {
        if (!(key in check.values)) continue;
        const next = check.values[key] ?? null;
        const previous = current[key] ?? null;
        if (next === previous) continue;
        changed.push(key);
        // Never a NULL name: `checkProfile` refuses a blank one, so every value
        // written here is one its column accepts.
        Object.assign(changes, { [key]: next });
        // `null` would drop out of a JSON column's keys; the empty string says
        // "was empty" / "cleared" without losing the key.
        before[key] = previous ?? '';
        after[key] = next ?? '';
      }

      if (changed.length === 0) return { user: current, before, after, changed, verification };
      options.guard?.(changed, verification);
      if (changed.includes('country') || changed.includes('nationality')) {
        const refused = offeredProblems(changes, await this.offered.get(tx));
        const refusal = firstProfileError(refused);
        if (refusal) throw new FieldValidationError(refusal, refused);
      }

      // One client per phone (0194): told on the field; the unique index decides a race.
      if (changes.phone && (await this.users.findIdByPhone(changes.phone, userId, tx))) {
        throw new PhoneAlreadyRegisteredError();
      }
      await tx
        .update(users)
        .set(changes)
        .where(eq(users.id, userId))
        .catch((error: unknown) => {
          if (violatesConstraint(error, 'users_phone_unique'))
            throw new PhoneAlreadyRegisteredError();
          throw error;
        });

      /*
       * A reviewer's flag on a field is ANSWERED by changing that field —
       * whoever changes it. The KYC step settled its own; a desk correction of
       * the same surname left the flag standing, so the client was still shown
       * a field to fix that somebody had already fixed.
       */
      const flagged = submission?.returnedItems ?? [];
      const unanswered = flagged.filter((id) => !(changed as string[]).includes(id));
      if (unanswered.length !== flagged.length) {
        await this.review.keepReturned(userId, unanswered, tx);
      }
      const audit =
        typeof options.audit === 'function'
          ? options.audit(changed, verification)
          : (options.audit ?? {});
      await this.auditLog.record(
        {
          actorId: actor.id,
          actorEmail: actor.email,
          actorKind: actor.kind,
          action: audit.action ?? 'client.profile_update',
          subjectType: audit.subjectType ?? 'user',
          subjectId: audit.subjectId ?? userId,
          details: {
            before,
            after,
            ...(audit.via ? { via: audit.via } : {}),
            ...(audit.reason ? { reason: audit.reason } : {}),
          },
        },
        tx,
      );
      const user = (await this.users.findById(userId, tx))!;
      return { user, before, after, changed, verification };
    };

    return options.executor ? run(options.executor) : this.db.transaction(run);
  }

  /**
   * AN ADMIN CHANGES A CLIENT'S DETAILS — from the client page or from the KYC
   * review, by ONE rule (`adminEditRule`) and one write.
   *
   * Every detail is `free`, `held` or a `correction`, decided under the locks
   * from where the verification is and whether this admin may correct verified
   * details. A correction needs a reason; it is re-checked, audited as
   * `kyc.identity_correct` on the verification with the reason and both
   * values, the client is emailed which details changed, and they STAY
   * verified. A held detail is refused with its sentence (409 `PROFILE_LOCKED`).
   *
   * It replaced two paths: the desk edit refused every verified detail with
   * "Use Correct details on the client's KYC review", and the review's
   * correction carried its own copy of the rules. The owner's report
   * (28 Sep 2026): being sent to another screen to edit a client is a bad
   * experience. The KYC review now calls this too (`KycReviewService.correctIdentity`).
   */
  async editAsAdmin(
    userId: number,
    input: Partial<Record<ProfileKey, unknown>>,
    actor: ProfileActor,
    options: {
      /** The admin holds `kyc.identity.correct`. */
      mayCorrect: boolean;
      /** Why a verified detail changes — required when one does. */
      reason?: string;
      /** Where the change came from, on the audit row. */
      via: 'admin_edit' | 'kyc_correction';
      /**
       * Refuse unless this IS a correction of a verified record — the review's
       * "Correct details", which exists for nothing else. Without it, a
       * verification that moved on between the screen and the save would turn
       * the reviewer's correction into a plain edit nobody meant to make.
       */
      correctionOnly?: boolean;
    },
  ) {
    const reason = options.reason?.trim() || undefined;
    const asOf = new Date();

    /*
     * A value that would DISQUALIFY a verified record — underage, an impossible
     * date — is a fact about the record, not a typo: 409 with its `kind`, so the
     * screen can say "this needs a rejection" rather than "fix the field". Asked
     * before the field rules, which would call it a plain 400. The status is
     * read here only to choose the refusal; the decision is re-made under the
     * locks below.
     */
    const { status, verifiedRequired } = await this.review.standingOf(userId);
    if (status === 'approved') {
      for (const [key, value] of Object.entries(input)) {
        if (!isProfileKey(key) || typeof value !== 'string' || value.trim() === '') continue;
        if (adminEditRule(key, status, options.mayCorrect).kind !== 'correction') continue;
        const outcome = normaliseProfileValue(key, value, asOf);
        if (
          !outcome.ok &&
          (outcome.code === 'underage' || outcome.code === 'invalid_date_of_birth')
        ) {
          throw new KycCorrectionRefusedError(
            `The corrected details do not pass verification: ${outcome.message} ` +
              'This is a fact about the RECORD, not about what you typed — a verified ' +
              'record cannot hold these values, so this is a rejection rather than an edit.',
            { kind: outcome.code, fields: [key] },
          );
        }
      }
    }

    const isCorrection = (changed: readonly ProfileKey[], verification: string | undefined) =>
      changed.some(
        (key) => adminEditRule(key, verification, options.mayCorrect).kind === 'correction',
      );

    const written = await this.update(userId, input, actor, {
      asOf,
      /*
       * A correction never CLEARS a detail the verification required — as the
       * form stood when the client submitted. Since Phase 2 the broker decides
       * that, so a detail the form left optional may be cleared on a verified
       * record, and one it required may not.
       */
      required: Object.keys(input).filter(
        (key): key is ProfileKey => isProfileKey(key) && verifiedRequired.includes(key),
      ),
      guard: (changed, verification) => {
        /*
         * `required` and the underage check above were chosen from the standing
         * read BEFORE the locks. If the verification moved since (an approval
         * racing this edit), they no longer fit it: refuse rather than clear a
         * detail the new verification required.
         */
        if ((verification === 'approved') !== (status === 'approved')) {
          throw new ConflictError(
            "The client's verification changed while you were editing. Reload and try again.",
          );
        }
        const held: Record<string, string> = {};
        for (const key of changed) {
          const rule = adminEditRule(key, verification, options.mayCorrect);
          if (rule.kind === 'held') held[key] = rule.sentence;
        }
        const first = Object.values(held)[0];
        if (first) throw new ProfileLockedError(first, held);

        const correcting = isCorrection(changed, verification);
        if (options.correctionOnly && !correcting) {
          throw new ValidationError(
            'This correction applies to a VERIFIED record, and this one no longer is.',
          );
        }
        if (correcting && !reason) {
          throw new FieldValidationError(
            'A verified detail changes only with a reason — it is recorded on the verification.',
            { reason: 'Give a reason for changing a verified detail.' },
          );
        }
      },
      audit: (changed, verification) =>
        isCorrection(changed, verification)
          ? {
              action: 'kyc.identity_correct',
              subjectType: 'kyc_submission',
              subjectId: userId,
              via: options.via,
              reason,
            }
          : { via: options.via },
    });

    const corrected = isCorrection(written.changed, written.verification);
    /*
     * The client is TOLD, always: a verified identity changed by somebody other
     * than its owner must never be silent. Which details — not their values,
     * which belong behind the client's own sign-in.
     */
    if (corrected && written.changed.length > 0) {
      void this.email?.sendKycDetailsCorrectedEmail(
        written.user.email,
        written.user.firstName,
        // Named in the language the mail is written in (0179).
        written.changed.map((key) => {
          const field = identityField(key);
          return field ? pickLocalized(field.label, field.labelAr, written.user.locale) : key;
        }),
        // A reviewer's correction: the client's stored language.
        written.user.locale,
      );
    }
    return { ...written, corrected };
  }
}
