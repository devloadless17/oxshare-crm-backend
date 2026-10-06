import { randomUUID } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import {
  BulkLeavesScopeError,
  BulkTargetChangedError,
  ValidationError,
} from '../../common/errors/domain-errors';
import { assertActorCan } from '../../common/security/actor';
import type { AuditWrite } from '../../store/audit-log.store';
import { AuditLogStore } from '../../store/audit-log.store';
import { ClientTagsStore } from '../../store/client-tags.store';
import { ResourceChangedPublisher } from '../../common/realtime/resource-changed';
import { AdminClientsService, type ClientListFilterQuery } from './admin-clients.service';
import type { AuthenticatedAdmin } from './guards/admin.guard';

/** Hand-picked rows: what a page of checkboxes can reach. */
export const BULK_IDS_MAX = 1000;
/** "Every client matching this filter": past this, narrow the filter. */
export const BULK_FILTER_MAX = 10_000;
/** No client carries more chosen tags than this — a row stays readable. */
export const TAGS_PER_CLIENT_MAX = 50;

/** Who a bulk action is for: picked rows, or every row matching a filter. */
export interface BulkTarget {
  ids?: number[];
  filter?: ClientListFilterQuery;
  /** The count the reader was SHOWN for `filter` — refused if it moved. */
  expectedCount?: number;
}

export interface BulkTagResult {
  /** Clients the action was asked about and may see. */
  matched: number;
  /** …of which actually changed. */
  changed: number;
  /** …of which already carried the change. */
  unchanged: number;
  /** Picked clients outside the actor's territory — counted, never touched. */
  skippedOutOfScope: number;
}

/**
 * Bulk actions on the clients list (the buyer's old CRM: select many, tag many).
 *
 * Every rule of a single tag change holds, decided ONCE for the whole set:
 *   - the target is resolved through the list's own filter and the actor's
 *     scope (`AdminClientsService.clientIdsMatching`), so a bulk change can
 *     never reach a client the screen did not show; picked ids outside the
 *     territory are skipped and counted;
 *   - "all matching" carries the count the reader saw, and a moved count is
 *     refused (409 `BULK_TARGET_CHANGED`) rather than acted on;
 *   - a change taking clients out of the actor's view needs the confirmation,
 *     with how many (409 `TAG_CHANGE_LEAVES_SCOPE`, `fields.count`);
 *   - a country tag is refused (derived, 0193);
 *   - one `client_tag.bulk` audit row, plus a per-client row carrying its
 *     `bulkId` for every client that really changed, in the change's own
 *     transaction.
 */
@Injectable()
export class AdminClientsBulkService {
  constructor(
    private readonly clients: AdminClientsService,
    private readonly tags: ClientTagsStore,
    private readonly auditLog: AuditLogStore,
    private readonly resourceChanged: ResourceChangedPublisher,
  ) {}

  /** The clients a bulk action is for, and how many picked ones were skipped. */
  async resolveTarget(
    target: BulkTarget,
    actor: AuthenticatedAdmin,
  ): Promise<{ ids: number[]; skippedOutOfScope: number }> {
    if (target.ids && target.filter) {
      throw new ValidationError('Choose clients either by picking them or by a filter — not both.');
    }
    if (target.ids) {
      const picked = [...new Set(target.ids)];
      if (picked.length === 0) throw new ValidationError('Pick at least one client.');
      if (picked.length > BULK_IDS_MAX) {
        throw new ValidationError(
          `Pick at most ${BULK_IDS_MAX} clients, or use "all matching" with a filter.`,
        );
      }
      const visible = await this.tags.visibleClientIds(picked, actor.clientScope);
      return { ids: visible, skippedOutOfScope: picked.length - visible.length };
    }
    if (target.filter) {
      if (target.expectedCount === undefined) {
        throw new ValidationError('"All matching" needs the count you were shown.');
      }
      const { ids, total } = await this.clients.clientIdsMatching(
        target.filter,
        actor,
        BULK_FILTER_MAX + 1,
      );
      if (total > BULK_FILTER_MAX) {
        throw new ValidationError(
          `This filter matches ${total} clients; a bulk action takes at most ${BULK_FILTER_MAX}. Narrow the filter.`,
        );
      }
      if (total !== target.expectedCount) throw new BulkTargetChangedError(total);
      return { ids, skippedOutOfScope: 0 };
    }
    throw new ValidationError('Choose which clients: pick them, or use "all matching".');
  }

  async bulkTags(
    input: { target: BulkTarget; add?: string[]; remove?: string[]; confirmLeavesScope?: boolean },
    actor: AuthenticatedAdmin,
  ): Promise<BulkTagResult> {
    assertActorCan(actor, 'clients.bulk', 'change many clients at once');
    assertActorCan(actor, 'clients.tag', 'tag clients');

    const add = [...new Set(input.add ?? [])];
    const remove = [...new Set(input.remove ?? [])];
    if (add.length === 0 && remove.length === 0) {
      throw new ValidationError('Choose a tag to add or to remove.');
    }
    if (add.some((id) => remove.includes(id))) {
      throw new ValidationError('A tag cannot be added and removed in the same change.');
    }
    const found = await this.tags.findByIds([...add, ...remove]);
    if (found.length !== add.length + remove.length) {
      throw new ValidationError('A chosen tag no longer exists. Reload and try again.');
    }
    const country = found.find((tag) => tag.countryCode);
    if (country) {
      throw new ValidationError(
        `"${country.label}" is a country tag: a client carries it while they live there. ` +
          "Change the client's country instead.",
      );
    }

    const { ids, skippedOutOfScope } = await this.resolveTarget(input.target, actor);
    if (ids.length === 0) {
      return { matched: 0, changed: 0, unchanged: 0, skippedOutOfScope };
    }

    const bulkId = randomUUID();
    const labelOf = new Map(found.map((tag) => [tag.id, tag.slug]));
    const changes = await this.tags.bulkChange({
      ids,
      add,
      remove,
      scope: actor.clientScope,
      actorId: actor.id,
      maxPerClient: TAGS_PER_CLIENT_MAX,
      onLeaves: (count) => {
        if (!input.confirmLeavesScope) throw new BulkLeavesScopeError(count);
      },
      onTooMany: (count) => {
        throw new ValidationError(
          `${count} client${count === 1 ? '' : 's'} would carry more than ${TAGS_PER_CLIENT_MAX} tags. Remove some first.`,
        );
      },
      record: async ({ added, removed }, tx) => {
        const changedIds = new Set([...added.keys(), ...removed.keys()]);
        const base = { actorId: actor.id, actorEmail: actor.email, actorKind: 'admin' as const };
        const rows: AuditWrite[] = [
          {
            ...base,
            action: 'client_tag.bulk',
            subjectType: 'client_list',
            subjectId: bulkId,
            details: {
              bulkId,
              add,
              remove,
              target: input.target.filter ? 'filter' : 'picked',
              filter: input.target.filter ?? null,
              matched: ids.length,
              changed: changedIds.size,
              skippedOutOfScope,
              leftActorScope: input.confirmLeavesScope === true,
            },
          },
        ];
        for (const [clientId, tagIds] of added) {
          for (const tagId of tagIds) {
            rows.push({
              ...base,
              action: 'client_tag.assign',
              subjectType: 'user',
              subjectId: clientId,
              details: { tagId, slug: labelOf.get(tagId), bulkId },
            });
          }
        }
        for (const [clientId, tagIds] of removed) {
          for (const tagId of tagIds) {
            rows.push({
              ...base,
              action: 'client_tag.unassign',
              subjectType: 'user',
              subjectId: clientId,
              details: { tagId, slug: labelOf.get(tagId), bulkId },
            });
          }
        }
        await this.auditLog.recordMany(rows, tx);
      },
    });

    const changed = new Set([...changes.added.keys(), ...changes.removed.keys()]).size;
    if (changed > 0) void this.resourceChanged.publish({ resource: 'clients' });
    return { matched: ids.length, changed, unchanged: ids.length - changed, skippedOutOfScope };
  }
}
