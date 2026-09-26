import { Inject, Injectable } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import { DRIZZLE_DB } from '../../database/database.module';
import type { Db, Executor } from '../../database/db';
import { users } from '../../database/schema';
import { FieldValidationError, NotFoundError } from '../../common/errors/domain-errors';
import {
  checkProfile,
  firstProfileError,
  PROFILE_FIELD_KEYS,
  type ClientProfile,
  type ProfileKey,
} from '../../common/profile/client-profile';
import { AuditLogStore } from '../../store/audit-log.store';
import { KycStore, type KycStatus } from '../../store/kyc.store';
import { UsersStore, type User } from '../../store/users.store';

/** Who is changing a profile — every change is recorded against somebody. */
export interface ProfileActor {
  kind: 'client' | 'admin' | 'system';
  id: string;
  email: string;
}

/**
 * The audit row a change writes. Defaults to `client.profile_update` on the
 * client's record; the KYC correction route keeps its own action and subject,
 * which investigators already filter by.
 */
export interface ProfileAuditOptions {
  action?: string;
  subjectType?: string;
  subjectId?: string;
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
 * status under that same row lock (`KycService.submit`), so holding it here
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
    private readonly kyc: KycStore,
  ) {}

  /**
   * Change a client's profile. `input` holds only the fields being written; a
   * blank one is cleared (names never are). Returns the user as stored and the
   * fields that actually moved.
   */
  async update(
    userId: string,
    input: Partial<Record<ProfileKey, unknown>>,
    actor: ProfileActor,
    options: {
      required?: readonly ProfileKey[];
      audit?: ProfileAuditOptions;
      executor?: Executor;
      asOf?: Date;
      /**
       * The caller's policy, asked with the fields that would ACTUALLY change
       * and the verification's status, both read under the locks. Throw to
       * refuse; nothing is written. Unchanged values never reach it, so a form
       * that sends back a locked field untouched is not refused for it.
       */
      guard?: (changed: readonly ProfileKey[], verification: KycStatus | undefined) => void;
    } = {},
  ): Promise<{ user: User; before: ClientProfile; after: ClientProfile; changed: ProfileKey[] }> {
    const check = checkProfile(input, { required: options.required, asOf: options.asOf });
    const message = firstProfileError(check.errors);
    if (message) {
      throw new FieldValidationError(message, check.errors);
    }

    const run = async (tx: Executor) => {
      const submission = await this.kyc.lockForUpdate(userId, tx);
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

      if (changed.length === 0) return { user: current, before, after, changed };
      options.guard?.(changed, verification);

      await tx.update(users).set(changes).where(eq(users.id, userId));

      /*
       * A reviewer's flag on a field is ANSWERED by changing that field —
       * whoever changes it. The KYC step settled its own; a desk correction of
       * the same surname left the flag standing, so the client was still shown
       * a field to fix that somebody had already fixed.
       */
      const flagged = submission?.rejectedFields ?? [];
      const unanswered = flagged.filter((id) => !(changed as string[]).includes(id));
      if (unanswered.length !== flagged.length) {
        await this.kyc.update(userId, { rejectedFields: unanswered }, tx);
      }
      const audit = options.audit ?? {};
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
      return { user, before, after, changed };
    };

    return options.executor ? run(options.executor) : this.db.transaction(run);
  }
}
