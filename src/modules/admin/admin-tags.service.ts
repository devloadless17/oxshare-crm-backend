import { Inject, Injectable } from '@nestjs/common';
import { DRIZZLE_DB } from '../../database/database.module';
import type { Db, Executor } from '../../database/db';
import {
  ClientTagsStore,
  type ClientTagAssignment,
  type ClientTag,
  type ClientTagWithCount,
} from '../../store/client-tags.store';
import { AdminClientScopesStore } from '../../store/admin-client-scopes.store';
import { UsersStore } from '../../store/users.store';
import { AdminsStore } from '../../store/admins.store';
import {
  ClientNotFoundError,
  ConflictError,
  NotFoundError,
  TagChangeLeavesScopeError,
  ValidationError,
} from '../../common/errors/domain-errors';
import { seesClientWithTags } from '../../common/security/client-scope';
import { AdminAuditService } from './admin-audit.service';
import { assertActorCan, assertActorCanAny } from '../../common/security/actor';
import type { AuthenticatedAdmin } from './guards/admin.guard';

/**
 * ADM-14 — client tags, and the rules that keep them from becoming a way round
 * the scoping built on top of them.
 *
 * Every method here takes an `AuthenticatedAdmin` rather than a bare `Admin`,
 * so a caller that has not resolved the actor's client scope cannot compile.
 */
/**
 * An assignment as a SCREEN reads it: the tag, plus who put it there.
 *
 * `assignedBy` is the stored id and `assignedByName` is that id resolved. Both
 * travel — the id is what an audit trail refers to, the name is what an
 * operator can act on.
 */
export interface ClientTagAssignmentView extends ClientTagAssignment {
  assignedByName: string | null;
}

/** What a tag change answers — see `ClientTagChangeResultDto`. */
export interface ClientTagChange {
  assignments: ClientTagAssignmentView[];
  stillVisible: boolean;
}

@Injectable()
export class AdminTagsService {
  constructor(
    private readonly tags: ClientTagsStore,
    private readonly scopes: AdminClientScopesStore,
    private readonly users: UsersStore,
    private readonly audit: AdminAuditService,
    /** Assigner names. Appended LAST — the positional-construction rule. */
    private readonly admins: AdminsStore,
    /** The transaction a tag change is judged and written in. Appended LAST. */
    @Inject(DRIZZLE_DB) private readonly db: Db,
  ) {}

  /**
   * A label becomes a slug: lower-case, alphanumerics and single hyphens.
   *
   * Derived rather than typed by the operator. The slug is what appears in a
   * `/clients?tag=` URL an admin pastes into a ticket, and asking a person for
   * two names for one thing produces `High Risk` / `high_risk` / `highrisk` in
   * the same table within a week.
   */
  static slugify(label: string): string {
    return label
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 64);
  }

  list(actor: AuthenticatedAdmin): Promise<ClientTagWithCount[]> {
    // R-4.3: asserted on the actor like every sibling method, not only in the
    // guard — the vocabulary names how the business sees its clients.
    assertActorCanAny(actor, ['tags.view', 'clients.view'], 'list client tags');
    // The count follows the reader's territory; the vocabulary does not. See
    // the store method's note for why those two halves differ.
    return this.tags.findAllWithCounts(actor.clientScope);
  }

  async create(
    input: { label: string; color?: string; description?: string },
    actor: AuthenticatedAdmin,
  ): Promise<ClientTag> {
    assertActorCan(actor, 'tags.create', 'create a client tag');

    const label = input.label.trim();
    if (label === '') throw new ValidationError('A tag needs a label.');

    const slug = AdminTagsService.slugify(label);
    if (slug === '') {
      throw new ValidationError(
        `"${label}" has no letters or digits to build a URL-safe name from. ` +
          'Use a label with at least one alphanumeric character.',
      );
    }
    if (await this.tags.findBySlug(slug)) {
      throw new ConflictError(`A tag named "${label}" already exists.`);
    }

    const tag = await this.tags.create({
      slug,
      label,
      color: input.color,
      description: input.description,
      createdBy: actor.id,
    });
    this.audit.record(actor.id, 'client_tag.create', 'client_tag', tag.id, { slug, label });
    return tag;
  }

  async update(
    id: string,
    patch: { label?: string; color?: string | null; description?: string | null },
    actor: AuthenticatedAdmin,
  ): Promise<ClientTag> {
    assertActorCan(actor, 'tags.edit', 'edit a client tag');

    const tag = await this.tags.findById(id);
    if (!tag) throw new NotFoundError('Tag not found.');

    /*
     * The LABEL is editable; the SLUG is not.
     *
     * The slug is in every saved `/clients?tag=` link, in tickets and in
     * bookmarks. Re-deriving it from a renamed label would break those silently
     * — the URL would still load and would simply show no clients, which reads
     * as "this segment is empty" rather than "this link is stale".
     */
    const updated = await this.tags.update(id, patch);
    if (!updated) throw new NotFoundError('Tag not found.');

    this.audit.record(actor.id, 'client_tag.update', 'client_tag', id, {
      before: { label: tag.label, color: tag.color },
      after: { label: updated.label, color: updated.color },
    });
    return updated;
  }

  async remove(id: string, actor: AuthenticatedAdmin): Promise<void> {
    assertActorCan(actor, 'tags.delete', 'delete a client tag');

    const tag = await this.tags.findById(id);
    if (!tag) throw new NotFoundError('Tag not found.');

    /*
     * A tag that is somebody's TERRITORY cannot be deleted.
     *
     * The database enforces this too (`admin_client_tag_scopes.tag_id` is ON
     * DELETE RESTRICT), and that FK is the real guarantee. This check exists to
     * turn its raw 23503 into a sentence naming the consequence, because the
     * consequence is not obvious: it silently changes what those administrators
     * see. (Before 0154 it was worse — an empty territory meant every client,
     * so the cascade PROMOTED an admin scoped to this tag alone to everyone.)
     */
    const scopedAdmins = await this.scopes.countForTags([id]);
    if (scopedAdmins > 0) {
      throw new ConflictError(
        `${scopedAdmins} administrator(s) have this tag in their territory. Deleting it would ` +
          'silently change which clients they see. Change their client access first.',
      );
    }

    /*
     * A scoped admin deletes a tag only if every client carrying it is one they
     * can see.
     *
     * Deleting a tag removes it from EVERY client that carries it. For a client
     * outside the actor's territory that is a change to a record they may not
     * even look at — and it could move another desk's clients into the "new
     * clients" pool, which the actor may see: a way to widen their own view by
     * deleting a label. The refusal gives the COUNT, never who (owner, 28 Sep
     * 2026: a count, no identity). Rename stays open: it changes a label, not
     * which clients carry it, and the slug a URL filters on never changes.
     *
     * The race is stated rather than hidden: a tag assigned to an out-of-scope
     * client in the instant between this count and the delete is removed with
     * the rest. It needs two admins on one tag in the same moment, and every
     * part of it is audited.
     */
    const outside = await this.tags.countClientsForTagOutside(id, actor.clientScope);
    if (outside > 0) {
      throw new ConflictError(
        `"${tag.label}" is also on ${outside} client${outside === 1 ? '' : 's'} outside your ` +
          'territory. Deleting it would change their records too, which only an administrator ' +
          'who can see them may do.',
      );
    }

    const assigned = await this.tags.countClientsForTag(id);
    await this.tags.delete(id);
    this.audit.record(actor.id, 'client_tag.delete', 'client_tag', id, {
      slug: tag.slug,
      label: tag.label,
      // Recorded because the assignments cascade away with it and there is
      // otherwise no trace of how many clients lost the label.
      assignmentsRemoved: assigned,
    });
  }

  // ─── assignment ───────────────────────────────────────────────────────────

  /**
   * Attach the assigner's NAME to each assignment, in one query.
   *
   * The store returns the id; a uuid does not answer "who put this client on
   * my desk". Null stays null — an assignment predating the column, or one by
   * an administrator since deleted, is an absence the screen states rather
   * than fills.
   */
  private async withAssigners(rows: ClientTagAssignment[]): Promise<ClientTagAssignmentView[]> {
    const names = await this.admins.namesByIds(
      rows.map((row) => row.assignedBy).filter((id): id is string => Boolean(id)),
    );
    return rows.map((row) => ({
      ...row,
      assignedByName: row.assignedBy ? (names.get(row.assignedBy) ?? null) : null,
    }));
  }

  async tagsForClient(
    clientId: string,
    actor: AuthenticatedAdmin,
  ): Promise<ClientTagAssignmentView[]> {
    assertActorCan(actor, 'clients.view', "view a client's tags");
    await this.assertClientVisible(clientId, actor);
    return this.withAssigners(await this.tags.tagsForClient(clientId));
  }

  /**
   * Put a tag on a client — ANY tag, including one outside the actor's own
   * territory (owner, 28 Sep 2026: "an admin can put any tags on the client
   * that is in his territory"). The client must be one they can see; the tag
   * need not be. That is how a desk hands a client to another desk, and how an
   * admin who sees new clients routes one to the right team.
   *
   * If the change takes the client out of the ACTOR's own view, it needs
   * `confirmLeavesScope` — see `changeTags`.
   */
  async assign(
    clientId: string,
    tagId: string,
    actor: AuthenticatedAdmin,
    options: { confirmLeavesScope?: boolean } = {},
  ): Promise<ClientTagChange> {
    assertActorCan(actor, 'clients.tag', 'tag a client');
    await this.assertClientVisible(clientId, actor);

    const tag = await this.tags.findById(tagId);
    if (!tag) throw new NotFoundError('Tag not found.');
    return this.changeTags(clientId, tag, 'assign', actor, options.confirmLeavesScope === true);
  }

  /**
   * Take a tag off a client — ANY tag, on the same terms as `assign`.
   *
   * This used to refuse two things: a tag outside the actor's territory, and
   * the LAST tag keeping the client in their view. The first made handing a
   * client over impossible. The second protected against a real risk — the
   * client vanishing mid-task, looking like a bug — and that risk is now met
   * by the confirmation instead of a flat refusal. It also ignored the "new
   * clients" grant: removing the last tag returns a client to intake, which an
   * admin holding the grant still sees, so there was nothing to protect.
   */
  async unassign(
    clientId: string,
    tagId: string,
    actor: AuthenticatedAdmin,
    options: { confirmLeavesScope?: boolean } = {},
  ): Promise<ClientTagChange> {
    assertActorCan(actor, 'clients.tag', 'untag a client');
    await this.assertClientVisible(clientId, actor);

    const tag = await this.tags.findById(tagId);
    if (!tag) throw new NotFoundError('Tag not found.');
    return this.changeTags(clientId, tag, 'unassign', actor, options.confirmLeavesScope === true);
  }

  /**
   * One rule for both directions: judge the tag set AFTER the change, and ask
   * for confirmation when it takes the client out of the actor's own view.
   *
   * Read, judge and write happen in ONE transaction under the client's tag
   * lock (`ClientTagsStore.lockAssignments`), so two concurrent changes cannot
   * each see the other's tag still in place and together hide the client from
   * the actor unconfirmed. Visibility is re-asked under the lock for the same
   * reason: another admin may have moved this client out of the actor's view
   * since `assertClientVisible` answered, and that answer is now 404 like any
   * other client they cannot see.
   *
   * An unrestricted actor sees every tag set, so they are never asked.
   */
  private async changeTags(
    clientId: string,
    tag: ClientTag,
    change: 'assign' | 'unassign',
    actor: AuthenticatedAdmin,
    confirmed: boolean,
  ): Promise<ClientTagChange> {
    const { changed, stillVisible } = await this.db.transaction(async (tx: Executor) => {
      await this.tags.lockAssignments(clientId, tx);

      const current = await this.tags.tagIdsForClient(clientId, tx);
      if (!seesClientWithTags(actor.clientScope, current)) throw new ClientNotFoundError();

      const after =
        change === 'assign'
          ? [...new Set([...current, tag.id])]
          : current.filter((id) => id !== tag.id);
      const visibleAfter = seesClientWithTags(actor.clientScope, after);
      if (!visibleAfter && !confirmed) {
        throw new TagChangeLeavesScopeError(
          `${change === 'assign' ? 'Adding' : 'Removing'} "${tag.label}" takes this client ` +
            'out of your territory: after this change you will no longer see them. Send the ' +
            'change again with confirmLeavesScope=true to hand them over.',
        );
      }

      const wrote =
        change === 'assign'
          ? await this.tags.assign(clientId, tag.id, actor.id, tx)
          : await this.tags.unassign(clientId, tag.id, tx);
      return { changed: wrote, stillVisible: visibleAfter };
    });

    // No audit row for a no-op. Recording "tagged" when the tag was already
    // there makes the trail describe events that did not happen.
    if (changed) {
      // A hand-off is the one change the actor cannot see the result of, so the
      // trail says so rather than leaving it to be inferred.
      const handedOver = stillVisible ? {} : { leftActorScope: true };
      /*
       * Two literal calls rather than one with a chosen action: the audit
       * census (`test/audit-details-census.spec.ts`) reads each `.record(`
       * call's action from its text, and a chosen one hides the second name
       * from the check that asks whether its payload is client-owned.
       */
      if (change === 'assign') {
        this.audit.record(actor.id, 'client_tag.assign', 'user', clientId, {
          tagId: tag.id,
          slug: tag.slug,
          ...handedOver,
        });
      } else {
        this.audit.record(actor.id, 'client_tag.unassign', 'user', clientId, {
          tagId: tag.id,
          slug: tag.slug,
          ...handedOver,
        });
      }
    }
    /*
     * Nothing else to do for intake — D-60, final form. "Untriaged" is the
     * DERIVED state of carrying no tags, so an assignment ends it by existing,
     * and removing the last tag returns the client to it.
     *
     * After a hand-off the client is outside the actor's territory, so nothing
     * more about them is returned — not even the tags just written.
     */
    return {
      assignments: stillVisible
        ? await this.withAssigners(await this.tags.tagsForClient(clientId))
        : [],
      stillVisible,
    };
  }

  /**
   * The client must be one this actor can see — 404 if not, never 403.
   *
   * A 403 would confirm that a client with that id exists, which turns tag
   * assignment into an oracle for enumerating the client base outside your
   * scope. The list endpoints get this for free from the WHERE clause; a
   * by-id write has to ask.
   */
  private async assertClientVisible(clientId: string, actor: AuthenticatedAdmin): Promise<void> {
    const client = await this.users.findForAdmin(clientId, actor.clientScope);
    if (!client) throw new ClientNotFoundError();
  }
}
