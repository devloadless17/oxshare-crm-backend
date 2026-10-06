import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  FieldValidationError,
  NotFoundError,
  SignupLinkTakenError,
} from '../../common/errors/domain-errors';
import { violatesConstraint } from '../../common/errors/pg-violation';
import { assertActorCan } from '../../common/security/actor';
import { randomSignupSlug, signupSlugProblem } from '../../common/signup-slug';
import { AdminsStore } from '../../store/admins.store';
import {
  SignupLinksStore,
  type SignupCounts,
  type SignupLinkTag,
} from '../../store/signup-links.store';
import { AdminAuditService } from './admin-audit.service';
import type { AuthenticatedAdmin } from './guards/admin.guard';

/** The caller's own link, as their profile shows it. */
export interface MySignupLink extends SignupCounts {
  slug: string;
  url: string;
  /** What a sign-up through it gets right now: their territory, minus countries. */
  tags: SignupLinkTag[];
  /**
   * True when the link gives no tag the caller can see — they see every client,
   * or only countries — so a client they bring is recorded as theirs but is not
   * put in a book of their own. Said, not refused.
   */
  addsNoTag: boolean;
}

/** One administrator's link on the Admin users page. */
export interface SignupLinkRow extends SignupCounts {
  adminId: string;
  name: string;
  slug: string;
  url: string;
  /** A suspended administrator's link tags nobody. */
  active: boolean;
}

/**
 * Administrators' sign-up links (0198): one per administrator, `/join/<slug>`,
 * giving their tags as they are at that moment. Rules:
 *   - your own link is yours: read and rename it on your profile;
 *   - everybody's is on the Admin users page (`admins.view`);
 *   - renaming somebody else's is `admins.edit`, and retires the old word.
 */
@Injectable()
export class SignupLinksService {
  constructor(
    private readonly links: SignupLinksStore,
    private readonly admins: AdminsStore,
    private readonly audit: AdminAuditService,
    private readonly config: ConfigService,
  ) {}

  private urlOf(slug: string): string {
    const portal = (this.config.get<string>('PORTAL_URL') ?? 'http://localhost:3000').replace(
      /\/+$/,
      '',
    );
    return `${portal}/join/${slug}`;
  }

  async mine(actor: AuthenticatedAdmin): Promise<MySignupLink> {
    const row = await this.links.one(actor.id);
    if (!row) throw new NotFoundError('Administrator not found.');
    const tags = await this.links.tagsFor(actor.id);
    return {
      slug: row.slug,
      url: this.urlOf(row.slug),
      tags,
      addsNoTag: tags.length === 0,
      ...row.counts,
    };
  }

  async list(actor: AuthenticatedAdmin): Promise<SignupLinkRow[]> {
    assertActorCan(actor, 'admins.view', "see administrators' sign-up links");
    return (await this.links.all()).map((row) => ({
      adminId: row.adminId,
      name: row.name,
      slug: row.slug,
      url: this.urlOf(row.slug),
      active: row.active,
      ...row.counts,
    }));
  }

  /** Rename an administrator's link. Your own freely; anybody else's with admins.edit. */
  async rename(
    adminId: string,
    raw: string,
    actor: AuthenticatedAdmin,
  ): Promise<{ slug: string; url: string }> {
    const before = await this.beforeChange(adminId, actor);
    const slug = raw.trim().toLowerCase();
    const problem = signupSlugProblem(slug);
    if (problem) throw new FieldValidationError(problem, { slug: problem });
    if (before === slug) return { slug, url: this.urlOf(slug) };
    try {
      await this.links.setSlug(adminId, slug);
    } catch (error) {
      if (violatesConstraint(error, 'admins_signup_slug_uq')) throw new SignupLinkTakenError();
      throw error;
    }
    return this.changed(adminId, before, slug, actor);
  }

  /**
   * Give an administrator's link a RANDOM word, made here (`randomSignupSlug`).
   * Same rule as a rename: your own freely, anybody else's with admins.edit,
   * and the old word stops working. A clash (one in ~10^12) is retried.
   */
  async randomize(
    adminId: string,
    actor: AuthenticatedAdmin,
  ): Promise<{ slug: string; url: string }> {
    const before = await this.beforeChange(adminId, actor);
    for (let attempt = 0; ; attempt++) {
      const slug = randomSignupSlug();
      try {
        await this.links.setSlug(adminId, slug);
        return this.changed(adminId, before, slug, actor);
      } catch (error) {
        if (!violatesConstraint(error, 'admins_signup_slug_uq') || attempt >= 4) throw error;
      }
    }
  }

  /** Who may change this link, and the word it has now. */
  private async beforeChange(
    adminId: string,
    actor: AuthenticatedAdmin,
  ): Promise<string | undefined> {
    if (adminId !== actor.id) {
      assertActorCan(actor, 'admins.edit', "change another administrator's sign-up link");
    }
    const admin = await this.admins.findById(adminId);
    if (!admin) throw new NotFoundError('Administrator not found.');
    return (await this.links.one(adminId))?.slug;
  }

  private changed(
    adminId: string,
    before: string | undefined,
    slug: string,
    actor: AuthenticatedAdmin,
  ): { slug: string; url: string } {
    this.audit.record(actor.id, 'admin.signup_link_change', 'admin', adminId, {
      before: before ?? null,
      after: slug,
    });
    return { slug, url: this.urlOf(slug) };
  }
}
