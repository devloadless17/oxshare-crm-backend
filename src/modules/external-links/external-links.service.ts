import { Inject, Injectable } from '@nestjs/common';
import { asc, eq } from 'drizzle-orm';
import { DRIZZLE_DB } from '../../database/database.module';
import type { Db } from '../../database/db';
import { externalLinks } from '../../database/schema';
import { NotFoundError, ValidationError } from '../../common/errors/domain-errors';
import { placeInOrder, renumber } from '../../common/ordering';
import type { Actor } from '../../common/security/actor';
import { AdminAuditService } from '../admin/admin-audit.service';
import type { CreateExternalLinkDto, UpdateExternalLinkDto } from './dto/external-link.dto';

/**
 * The links the operator puts on the client portal's sidebar.
 *
 * An economic calendar, the broker's help centre, a Telegram channel, a
 * market-analysis blog. The operator adds them from the admin console and every
 * signed-in client sees them in the portal menu.
 *
 * Deliberately shaped like `CurrenciesService` and `LeveragesService` — an admin
 * list that includes what has been withdrawn, a client list that does not,
 * `placeInOrder` for the position, and an audit row per write. The only
 * structural difference is the surrogate id, and `dto/external-link.dto.ts` says
 * why a link has no natural key to use instead.
 */
@Injectable()
export class ExternalLinksService {
  constructor(
    @Inject(DRIZZLE_DB) private readonly db: Db,
    private readonly audit: AdminAuditService,
  ) {}

  /** Everything, operator order first. The admin screen's list. */
  listAll() {
    return this.db
      .select()
      .from(externalLinks)
      .orderBy(asc(externalLinks.sortOrder), asc(externalLinks.title));
  }

  /**
   * What a CLIENT sees, in the operator's order.
   *
   * Disabled links are ABSENT rather than flagged, the same call
   * `LeveragesService.listEnabled` makes: a client has no use for "you cannot
   * open this", and a portal that received them would have to remember to
   * filter — which is the kind of thing one screen forgets, and here the
   * forgetting is visible to every customer.
   *
   * There is no fallback for an EMPTY table, unlike the leverage ladder. An
   * empty ladder leaves a client an account-opening form with no options, which
   * they cannot fix from where they stand; no external links is a sidebar with
   * no extra section, which is a complete and correct screen.
   *
   * `enabled` and the audit columns are not selected. The client is not being
   * told which links exist but are switched off, and `updatedBy` is the id of an
   * administrator — neither belongs in a response every customer receives.
   */
  listEnabled() {
    return this.db
      .select({
        id: externalLinks.id,
        title: externalLinks.title,
        description: externalLinks.description,
        url: externalLinks.url,
        sortOrder: externalLinks.sortOrder,
      })
      .from(externalLinks)
      .where(eq(externalLinks.enabled, true))
      .orderBy(asc(externalLinks.sortOrder), asc(externalLinks.title));
  }

  async findOne(id: string) {
    const [row] = await this.db
      .select()
      .from(externalLinks)
      .where(eq(externalLinks.id, id))
      .limit(1);
    return row ?? null;
  }

  async create(dto: CreateExternalLinkDto, actor: Actor) {
    const title = dto.title.trim();
    if (title === '') {
      throw new ValidationError('A link needs a title — it is what the client reads.');
    }

    const url = assertSafeExternalUrl(dto.url);

    /*
     * TRANSACTIONAL, because placing this link renumbers the ones it displaces.
     * A failure between the renumber and the insert would leave the menu with a
     * hole where this entry was going to sit — the same reason
     * `LeveragesService.create` opens one.
     */
    const created = await this.db.transaction(async (tx) => {
      const [row] = await tx
        .insert(externalLinks)
        .values({
          title,
          description: dto.description?.trim() || null,
          url,
          enabled: dto.enabled ?? true,
          sortOrder: await this.placeOrder(tx, null, dto.sortOrder),
          updatedBy: actor.id,
        })
        .returning();
      return row;
    });

    this.audit.record(actor.id, 'external_link.create', 'external_links', created.id, {
      title: created.title,
      url: created.url,
    });
    return created;
  }

  async update(id: string, dto: UpdateExternalLinkDto, actor: Actor) {
    const current = await this.findOne(id);
    if (!current) throw new NotFoundError('No such link.');

    const title = dto.title?.trim();
    if (dto.title !== undefined && !title) {
      throw new ValidationError('A link needs a title — it is what the client reads.');
    }
    const url = dto.url === undefined ? undefined : assertSafeExternalUrl(dto.url);

    const updated = await this.db.transaction(async (tx) => {
      const [row] = await tx
        .update(externalLinks)
        .set({
          ...(title !== undefined ? { title } : {}),
          // An empty string CLEARS it — see `UpdateExternalLinkDto.description`.
          ...(dto.description !== undefined ? { description: dto.description.trim() || null } : {}),
          ...(url !== undefined ? { url } : {}),
          ...(dto.enabled !== undefined ? { enabled: dto.enabled } : {}),
          ...(dto.sortOrder !== undefined
            ? { sortOrder: await this.placeOrder(tx, id, dto.sortOrder) }
            : {}),
          updatedBy: actor.id,
          updatedAt: new Date(),
        })
        .where(eq(externalLinks.id, id))
        .returning();
      return row;
    });

    /*
     * Only the fields that MOVED, with what they were — the shape every other
     * configuration audit row in this codebase takes, and the reason
     * `platform_link.set` keeps a `before`: the current value answers nothing
     * about a link that pointed somewhere wrong for six hours last Tuesday.
     */
    const changed: Record<string, { before: unknown; after: unknown }> = {};
    for (const key of ['title', 'description', 'url', 'enabled', 'sortOrder'] as const) {
      if (current[key] !== updated[key]) {
        changed[key] = { before: current[key], after: updated[key] };
      }
    }
    if (Object.keys(changed).length > 0) {
      this.audit.record(actor.id, 'external_link.update', 'external_links', id, changed);
    }
    return updated;
  }

  /**
   * Delete a link, and close the gap it leaves.
   *
   * There is no refusal to guard, unlike `LeveragesService.remove`: nothing in
   * this system references a link, so removing one orphans nothing. What it
   * would otherwise leave behind is a hole in the numbering — `placeInOrder`
   * cannot see it, because it is only ever given the rows that remain — so the
   * renumber happens here, inside the same transaction as the delete.
   */
  async remove(id: string, actor: Actor) {
    const current = await this.findOne(id);
    if (!current) throw new NotFoundError('No such link.');

    await this.db.transaction(async (tx) => {
      await tx.delete(externalLinks).where(eq(externalLinks.id, id));

      const rows = await tx
        .select({ id: externalLinks.id, sortOrder: externalLinks.sortOrder })
        .from(externalLinks);

      /*
       * `renumber` is the pure counterpart of `placeInOrder` and exists for
       * exactly this: removing position 2 of five leaves `0,1,3,4`, and that
       * gap is invisible until somebody types 3 into the form and lands on top
       * of a row instead of before it. It reports only what moves, so a list
       * that was already tidy costs no writes.
       */
      for (const change of renumber(rows)) {
        await tx
          .update(externalLinks)
          .set({ sortOrder: change.sortOrder })
          .where(eq(externalLinks.id, change.id));
      }
    });

    this.audit.record(actor.id, 'external_link.delete', 'external_links', id, {
      title: current.title,
      url: current.url,
    });
  }

  /**
   * Give this link the position asked for, moving whoever is in the way.
   *
   * `id` is null for a CREATE — the row does not exist yet, so `placeInOrder` is
   * told about a target absent from the list and answers with the position it
   * should be inserted at plus the shifts that make room. A sentinel stands in
   * for the target so its own change can be told apart from everyone else's; it
   * never reaches the database, and it cannot collide with a real row because
   * every real id is a uuid.
   */
  private async placeOrder(
    tx: Parameters<Parameters<Db['transaction']>[0]>[0],
    id: string | null,
    desired: number | undefined,
  ): Promise<number> {
    const rows = await tx
      .select({ id: externalLinks.id, sortOrder: externalLinks.sortOrder })
      .from(externalLinks);

    const targetId = id ?? '__new__';
    const changes = placeInOrder(rows, targetId, desired);

    let position = rows.find((row) => row.id === targetId)?.sortOrder ?? rows.length;

    for (const change of changes) {
      if (change.id === targetId) {
        position = change.sortOrder;
        continue;
      }
      await tx
        .update(externalLinks)
        .set({ sortOrder: change.sortOrder })
        .where(eq(externalLinks.id, change.id));
    }

    return position;
  }
}

/**
 * Refuse a URL the portal would render as a link.
 *
 * Written by an admin, handed to every client as an `href`. `javascript:` in an
 * anchor executes on click, in the client's session, on the portal's origin — so
 * an admin account, or anything that compromises one, could turn the sidebar
 * into stored XSS against every client who signs in. `data:` is the same trick
 * wearing a different scheme.
 *
 * Parsed rather than pattern-matched, because the browser's parser is the
 * authority on what a string navigates to and hand-rolled checks keep losing to
 * it — the same reasoning `assertSafeDownloadUrl` and `safeReturnTo` record.
 *
 * ── Why `http:` is allowed here and NOT for a platform download ─────────────
 *
 * `assertSafeDownloadUrl` refuses everything but https, because that link is how
 * a client obtains an EXECUTABLE and a channel anyone on the path can rewrite
 * defeats the point of hosting the download at all. Nothing is installed from
 * here: these are pages a client reads, opened in a new tab as a top-level
 * navigation, so no mixed-content rule applies either. A regulator's page or a
 * partner resource still served over plain http is a real thing an operator has
 * to be able to link, and refusing it would not make anybody safer — it would
 * move the link somewhere this code cannot check it at all.
 *
 * Returns the trimmed value, so the caller stores exactly what was checked.
 */
export function assertSafeExternalUrl(raw: string): string {
  const trimmed = raw.trim();

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new ValidationError(
      'That is not a complete URL. Include the scheme, for example https://example.com/calendar',
    );
  }

  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new ValidationError(
      `A link must be http or https. '${parsed.protocol}' is not allowed — this URL becomes a ` +
        "link in every client's browser.",
    );
  }

  return trimmed;
}
