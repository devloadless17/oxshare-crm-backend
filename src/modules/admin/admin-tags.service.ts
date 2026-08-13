import { Injectable } from '@nestjs/common';
import {
  ClientTagsStore,
  type ClientTag,
  type ClientTagWithCount,
} from '../../store/client-tags.store';
import { AdminClientScopesStore } from '../../store/admin-client-scopes.store';
import { UsersStore } from '../../store/users.store';
import {
  ClientNotFoundError,
  ConflictError,
  NotFoundError,
  ValidationError,
} from '../../common/errors/domain-errors';
import { AdminAuditService } from './admin-audit.service';
import { assertActorCan } from '../../common/security/actor';
import type { AuthenticatedAdmin } from './guards/admin.guard';

/**
 * ADM-14 — client tags, and the rules that keep them from becoming a way round
 * the scoping built on top of them.
 *
 * Every method here takes an `AuthenticatedAdmin` rather than a bare `Admin`,
 * so a caller that has not resolved the actor's client scope cannot compile.
 */
@Injectable()
export class AdminTagsService {
  constructor(
    private readonly tags: ClientTagsStore,
    private readonly scopes: AdminClientScopesStore,
    private readonly users: UsersStore,
    private readonly audit: AdminAuditService,
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

  list(): Promise<ClientTagWithCount[]> {
    return this.tags.findAllWithCounts();
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
     * A SYSTEM tag cannot be deleted at all — the product itself writes it.
     *
     * The scope guard below protects a tag once somebody's territory
     * references it; `new-client` (D-60) is load-bearing BEFORE that moment,
     * because registration attaches it. Deleting it would silently turn
     * intake back into a pool only unrestricted admins can see. Same pattern
     * as the four mandated KYC steps: label and colour stay editable,
     * existence is not negotiable. Un-assigning it from a client stays
     * allowed — that is triage, not deletion.
     */
    if (tag.isSystem) {
      throw new ConflictError(
        `"${tag.label}" is a system tag — the platform assigns it automatically ` +
          '(new registrations land in it), so it cannot be deleted. Its label and ' +
          'colour can be edited, and removing it from individual clients is how ' +
          'they are triaged out of it.',
      );
    }

    /*
     * A tag that is somebody's TERRITORY cannot be deleted.
     *
     * The database enforces this too (`admin_client_tag_scopes.tag_id` is ON
     * DELETE RESTRICT), and that FK is the real guarantee. This check exists to
     * turn its raw 23503 into a sentence naming the consequence, because the
     * consequence is not obvious: an empty scope means UNRESTRICTED, so
     * cascading this delete would PROMOTE every admin scoped to it to seeing
     * every client in the system.
     */
    const scopedAdmins = await this.scopes.countForTags([id]);
    if (scopedAdmins > 0) {
      throw new ConflictError(
        `${scopedAdmins} administrator(s) are restricted to this tag. Deleting it would ` +
          'give them access to every client instead of none. Change their client scope first.',
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

  async tagsForClient(clientId: string, actor: AuthenticatedAdmin): Promise<ClientTag[]> {
    assertActorCan(actor, 'clients.view', "view a client's tags");
    await this.assertClientVisible(clientId, actor);
    return this.tags.tagsForClient(clientId);
  }

  async assign(clientId: string, tagId: string, actor: AuthenticatedAdmin): Promise<ClientTag[]> {
    assertActorCan(actor, 'clients.tag', 'tag a client');
    await this.assertClientVisible(clientId, actor);

    const tag = await this.tags.findById(tagId);
    if (!tag) throw new NotFoundError('Tag not found.');
    this.assertTagWithinScope(tag, actor);

    const created = await this.tags.assign(clientId, tagId, actor.id);
    // No audit row for a no-op. Recording "tagged" when the tag was already
    // there makes the trail describe events that did not happen.
    if (created) {
      this.audit.record(actor.id, 'client_tag.assign', 'user', clientId, {
        tagId,
        slug: tag.slug,
      });
    }
    /*
     * Nothing else to do for intake — D-60, final form. "Untriaged" is the
     * DERIVED state of carrying no tags, so this assignment has already ended
     * it by existing. No second tag to remove, no second audit row to write.
     */
    return this.tags.tagsForClient(clientId);
  }

  async unassign(clientId: string, tagId: string, actor: AuthenticatedAdmin): Promise<ClientTag[]> {
    assertActorCan(actor, 'clients.tag', 'untag a client');
    await this.assertClientVisible(clientId, actor);

    const tag = await this.tags.findById(tagId);
    if (!tag) throw new NotFoundError('Tag not found.');
    this.assertTagWithinScope(tag, actor);

    /*
     * A scoped admin may not remove the LAST tag keeping a client in their own
     * view.
     *
     * The direct mirror of the IP allowlist's "you may not delete the last rule
     * that is keeping you in", and it exists for the same reason: the biggest
     * operational risk in a self-service control is an irreversible action that
     * removes the screen you would use to undo it. Here the client would vanish
     * from the actor's list mid-task, looking for all the world like a bug.
     */
    if (!actor.clientScope.unrestricted) {
      const current = await this.tags.tagsForClient(clientId);
      const remaining = current
        .filter((t) => t.id !== tagId)
        .filter((t) => actor.clientScope.tagIds.includes(t.id));
      if (remaining.length === 0) {
        throw new ValidationError(
          `Refusing: "${tag.label}" is the only tag putting this client in your view, so ` +
            'removing it would hide them from you immediately and you could not put it back. ' +
            'Add another tag you can see first.',
        );
      }
    }

    const removed = await this.tags.unassign(clientId, tagId);
    if (removed) {
      this.audit.record(actor.id, 'client_tag.unassign', 'user', clientId, {
        tagId,
        slug: tag.slug,
      });
    }
    return this.tags.tagsForClient(clientId);
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

  /**
   * A scoped admin may only apply tags inside their own territory.
   *
   * Without this, scoping is self-service: tag a client with something outside
   * your scope and they leave your view; tag one of your own clients into
   * another desk's territory and you have moved a record you do not own. The
   * first is merely confusing, the second is a real change to somebody else's
   * workload with your name on it.
   */
  private assertTagWithinScope(tag: ClientTag, actor: AuthenticatedAdmin): void {
    if (actor.clientScope.unrestricted) return;
    if (!actor.clientScope.tagIds.includes(tag.id)) {
      throw new ValidationError(
        `You can only apply tags within your own client scope. "${tag.label}" is outside it.`,
      );
    }
  }
}
