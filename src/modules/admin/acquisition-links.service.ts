import { Injectable } from '@nestjs/common';
import {
  AuthorizationError,
  ConflictError,
  NotFoundError,
  ValidationError,
} from '../../common/errors/domain-errors';
import { actorHasPermission, assertActorCanAny } from '../../common/security/actor';
import { randomReferralCode } from '../../common/referral-code';
import { AcquisitionLinksStore, type AcquisitionLink } from '../../store/acquisition-links.store';
import { AdminClientScopesStore } from '../../store/admin-client-scopes.store';
import { AdminsStore } from '../../store/admins.store';
import { ClientTagsStore } from '../../store/client-tags.store';
import { AdminAuditService } from './admin-audit.service';
import type { AuthenticatedAdmin } from './guards/admin.guard';

/** A link as the console shows it: plus whether its owner will see what it brings. */
export interface AcquisitionLinkView extends AcquisitionLink {
  /**
   * False when none of the link's tags is in the owner's territory (and the
   * owner does not see every client): every client it brings is invisible to
   * the person handing it out. Said, not refused — routing sign-ups to another
   * desk is a legitimate use.
   */
  ownerSeesSignups: boolean;
}

/**
 * Administrators' sign-up links (0195).
 *
 * The one rule that matters: a link's tags decide who will SEE the clients it
 * brings (a tag is a territory). So `links.create` may only put tags from the
 * actor's OWN territory on the actor's OWN link — no funnelling sign-ups into a
 * book the actor cannot see, or into nobody's. `links.manage` may do anything
 * for anyone, including handing a link to another administrator.
 */
@Injectable()
export class AcquisitionLinksService {
  constructor(
    private readonly links: AcquisitionLinksStore,
    private readonly tags: ClientTagsStore,
    private readonly scopes: AdminClientScopesStore,
    private readonly admins: AdminsStore,
    private readonly audit: AdminAuditService,
  ) {}

  async list(): Promise<AcquisitionLinkView[]> {
    return Promise.all((await this.links.list()).map((link) => this.view(link)));
  }

  async create(
    input: { name: string; ownerAdminId?: string; tagIds?: string[] },
    actor: AuthenticatedAdmin,
  ): Promise<AcquisitionLinkView> {
    const ownerAdminId = input.ownerAdminId ?? actor.id;
    this.assertMayActFor(ownerAdminId, actor);
    await this.assertOwnerActive(ownerAdminId);
    const name = input.name.trim();
    if (name === '') throw new ValidationError('A link needs a name.');

    const tagIds = input.tagIds ?? (await this.defaultTagsFor(ownerAdminId));
    await this.assertTagsAllowed(tagIds, actor);

    const id = await this.links.create({
      code: await this.freshCode(),
      name,
      ownerAdminId,
      tagIds: [...new Set(tagIds)],
      createdBy: actor.id,
    });
    const link = await this.mustFind(id);
    this.audit.record(actor.id, 'acquisition_link.create', 'acquisition_link', id, {
      code: link.code,
      name,
      ownerAdminId,
      tagIds: link.tags.map((tag) => tag.id),
    });
    return this.view(link);
  }

  async update(
    id: string,
    patch: { name?: string; ownerAdminId?: string; tagIds?: string[]; disabled?: boolean },
    actor: AuthenticatedAdmin,
  ): Promise<AcquisitionLinkView> {
    const before = await this.mustFind(id);
    this.assertMayActFor(before.ownerAdminId, actor);
    if (patch.ownerAdminId !== undefined && patch.ownerAdminId !== before.ownerAdminId) {
      // Handing a link over moves where its sign-ups' OWNER sits: manage only.
      if (!actorHasPermission(actor, 'links.manage')) {
        throw new AuthorizationError('Handing a link to another administrator needs links.manage.');
      }
      await this.assertOwnerActive(patch.ownerAdminId);
    }
    if (patch.tagIds !== undefined) await this.assertTagsAllowed(patch.tagIds, actor);
    const name = patch.name?.trim();
    if (name === '') throw new ValidationError('A link needs a name.');

    await this.links.update(id, {
      name,
      ownerAdminId: patch.ownerAdminId,
      tagIds: patch.tagIds === undefined ? undefined : [...new Set(patch.tagIds)],
    });
    if (patch.disabled !== undefined && patch.disabled !== (before.disabledAt !== null)) {
      await this.links.setDisabled(id, patch.disabled);
    }
    const after = await this.mustFind(id);
    this.audit.record(
      actor.id,
      patch.disabled === true && before.disabledAt === null
        ? 'acquisition_link.disable'
        : 'acquisition_link.update',
      'acquisition_link',
      id,
      {
        before: summary(before),
        after: summary(after),
      },
    );
    return this.view(after);
  }

  // ─── rules ────────────────────────────────────────────────────────────────

  /** Your own link with `links.create`; anybody's with `links.manage`. */
  private assertMayActFor(ownerAdminId: string, actor: AuthenticatedAdmin) {
    if (ownerAdminId === actor.id) {
      assertActorCanAny(actor, ['links.create', 'links.manage'], 'manage your sign-up links');
      return;
    }
    if (!actorHasPermission(actor, 'links.manage')) {
      throw new AuthorizationError(
        "Another administrator's sign-up links need links.manage. You can manage your own.",
      );
    }
  }

  private async assertOwnerActive(adminId: string) {
    const owner = await this.admins.findById(adminId);
    if (!owner) throw new NotFoundError('That administrator does not exist.');
    if (owner.status !== 'active') {
      throw new ValidationError(
        `${owner.name} is suspended: a link they own would tag nobody. Choose an active administrator.`,
      );
    }
  }

  /**
   * Every tag exists and is not a country (those are derived). Without
   * `links.manage`, every tag must be in the actor's own territory — unless the
   * actor sees every client, in which case every tag is theirs to hand out.
   */
  private async assertTagsAllowed(tagIds: readonly string[], actor: AuthenticatedAdmin) {
    const unique = [...new Set(tagIds)];
    const found = await this.tags.findByIds(unique);
    const known = new Map(found.map((tag) => [tag.id, tag]));
    const missing = unique.filter((id) => !known.has(id));
    if (missing.length > 0) throw new ValidationError('A tag on this link no longer exists.');
    const country = found.find((tag) => tag.countryCode);
    if (country) {
      throw new ValidationError(
        `"${country.label}" is a country tag: every client living there carries it already.`,
      );
    }
    if (actorHasPermission(actor, 'links.manage') || actor.clientScope.unrestricted) return;
    const beyond = found.filter((tag) => !actor.clientScope.tagIds.includes(tag.id));
    if (beyond.length > 0) {
      throw new AuthorizationError(
        `You can only put tags from your own territory on a link (not "${beyond[0].label}"): ` +
          'the clients it brings would land where you cannot see them.',
      );
    }
  }

  /** The owner's own territory, without its countries — their book. */
  private async defaultTagsFor(adminId: string): Promise<string[]> {
    const territory = await this.scopes.tagIdsFor(adminId);
    const tags = await this.tags.findByIds(territory);
    return tags.filter((tag) => !tag.countryCode).map((tag) => tag.id);
  }

  private async freshCode(): Promise<string> {
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const code = randomReferralCode();
      if (!(await this.links.codeTaken(code))) return code;
    }
    throw new ConflictError('Could not allocate a link code. Please try again.');
  }

  private async mustFind(id: string): Promise<AcquisitionLink> {
    const link = await this.links.findById(id);
    if (!link) throw new NotFoundError('Sign-up link not found.');
    return link;
  }

  private async view(link: AcquisitionLink): Promise<AcquisitionLinkView> {
    const owner = await this.admins.findById(link.ownerAdminId);
    const territory = await this.scopes.tagIdsFor(link.ownerAdminId);
    const seesAll = territory.length === 0 && (owner?.seesAllClients ?? false);
    return {
      ...link,
      ownerSeesSignups: seesAll || link.tags.some((tag) => territory.includes(tag.id)),
    };
  }
}

function summary(link: AcquisitionLink) {
  return {
    name: link.name,
    ownerAdminId: link.ownerAdminId,
    tagIds: link.tags.map((tag) => tag.id),
    disabled: link.disabledAt !== null,
  };
}
