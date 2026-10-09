import { Inject, Injectable } from '@nestjs/common';
import { DRIZZLE_DB } from '../../database/database.module';
import type { Db } from '../../database/db';
import { assertFollowUpDate, noteText } from '../../common/client-follow-up';
import { ClientNotFoundError, FollowUpStaleError } from '../../common/errors/domain-errors';
import { assertActorCan } from '../../common/security/actor';
import {
  ClientFollowupsStore,
  type FollowUpRecord,
  type FollowUpValues,
} from '../../store/client-followups.store';
import { UsersStore } from '../../store/users.store';
import { AdminAuditService } from './admin-audit.service';
import type { ClientFollowUpDto } from './dto/client-followup.dto';
import type { AuthenticatedAdmin } from './guards/admin.guard';

/** What a save asks for, as the route received it. */
export interface FollowUpSave {
  followUp: string | null;
  result: string | null;
  /** An ISO date-time with its offset, already shape-checked by the DTO. */
  followUpAt: string | null;
  version: number;
}

const STALE =
  'A colleague changed these notes while you were editing. Your text was not saved: compare ' +
  'it with theirs, then save again.';

/** Same notes and the same moment — what decides whether a save changes anything. */
function sameValues(a: FollowUpValues, b: FollowUpValues): boolean {
  return (
    a.followUp === b.followUp &&
    a.result === b.result &&
    (a.followUpAt?.getTime() ?? null) === (b.followUpAt?.getTime() ?? null)
  );
}

function view(record: FollowUpRecord): ClientFollowUpDto {
  return {
    followUp: record.followUp,
    result: record.result,
    followUpAt: record.followUpAt,
    version: record.version,
    updatedAt: record.updatedAt,
    updatedBy:
      record.updatedByAdminId && record.updatedByName
        ? { id: record.updatedByAdminId, name: record.updatedByName }
        : null,
  };
}

/**
 * A client's Follow-up and Result (0212) — the staff's two notes, named by the
 * buyer: what to do next (with an optional date) and how the last contact went.
 *
 * - Read with `clients.view`, written with `clients.followup.edit`, and only for
 *   a client in the reader's territory: out of scope is 404, like the profile.
 * - A save names the version it was made from. One made from an older version
 *   is refused (`FOLLOWUP_STALE`) rather than silently replacing a colleague's
 *   words; a save that changes nothing succeeds whatever its version, so a
 *   double click or a retried request is never a conflict.
 * - Every change is an audit row (`client.followup_update`, before and after)
 *   written in the same transaction — the notes' history.
 */
@Injectable()
export class AdminClientFollowupService {
  constructor(
    @Inject(DRIZZLE_DB) private readonly db: Db,
    private readonly users: UsersStore,
    private readonly followups: ClientFollowupsStore,
    private readonly audit: AdminAuditService,
  ) {}

  async get(clientId: number, actor: AuthenticatedAdmin): Promise<ClientFollowUpDto> {
    assertActorCan(actor, 'clients.view', "read a client's follow-up");
    await this.assertVisible(clientId, actor);
    return view(await this.followups.find(clientId));
  }

  async save(
    clientId: number,
    input: FollowUpSave,
    actor: AuthenticatedAdmin,
    now: Date = new Date(),
  ): Promise<ClientFollowUpDto> {
    assertActorCan(actor, 'clients.followup.edit', "edit a client's follow-up");
    await this.assertVisible(clientId, actor);

    const next: FollowUpValues = {
      followUp: noteText(input.followUp),
      result: noteText(input.result),
      followUpAt: input.followUpAt === null ? null : new Date(input.followUpAt),
    };

    await this.db.transaction(async (tx) => {
      const current = await this.followups.findForUpdate(clientId, tx);
      if (sameValues(current, next)) return;
      if (current.version !== input.version) throw new FollowUpStaleError(STALE);

      const dateChanged =
        (current.followUpAt?.getTime() ?? null) !== (next.followUpAt?.getTime() ?? null);
      if (next.followUpAt && dateChanged) assertFollowUpDate(next.followUpAt, now);

      const version = await this.followups.save(clientId, input.version, next, actor.id, tx);
      // A first save raced by another first save: the row exists now, and is theirs.
      if (version === undefined) throw new FollowUpStaleError(STALE);

      await this.audit.recordWithin(tx, actor.id, 'client.followup_update', 'user', clientId, {
        before: {
          followUp: current.followUp,
          result: current.result,
          followUpAt: current.followUpAt?.toISOString() ?? null,
        },
        after: {
          followUp: next.followUp,
          result: next.result,
          followUpAt: next.followUpAt?.toISOString() ?? null,
        },
      });
    });

    return view(await this.followups.find(clientId));
  }

  /** Out of the reader's territory reads exactly like a client that does not exist. */
  private async assertVisible(clientId: number, actor: AuthenticatedAdmin): Promise<void> {
    const client = await this.users.findForAdmin(clientId, actor.clientScope);
    if (!client) throw new ClientNotFoundError();
  }
}
