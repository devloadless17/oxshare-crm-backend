import { Inject, Injectable, Logger } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import { DRIZZLE_DB } from '../../database/database.module';
import type { Db } from '../../database/db';
import { platformLinks } from '../../database/schema';
import { ValidationError } from '../../common/errors/domain-errors';
import type { Admin } from '../../store/admins.store';

/**
 * The download links for the trading terminal, and who may change them.
 *
 * Read by the client portal (`GET /platforms`) and written from the admin
 * settings screen. One row per platform, seeded empty.
 */

/** The three platforms the portal offers, in presentation order. */
export const PLATFORM_KEYS = ['desktop', 'ios', 'android'] as const;
export type PlatformKey = (typeof PLATFORM_KEYS)[number];

export function isPlatformKey(value: string): value is PlatformKey {
  return (PLATFORM_KEYS as readonly string[]).includes(value);
}

export interface PlatformLink {
  key: PlatformKey;
  url: string | null;
  updatedAt: string | null;
}

@Injectable()
export class PlatformLinksService {
  private readonly logger = new Logger(PlatformLinksService.name);

  constructor(@Inject(DRIZZLE_DB) private readonly db: Db) {}

  /**
   * All three, always, in a fixed order — even the ones nobody has configured.
   *
   * Returning only the rows that exist would make "not set up yet" and "this
   * platform is not offered" the same response, and the portal cannot tell them
   * apart. The list of platforms is a product decision that lives in
   * `PLATFORM_KEYS`; the URL is operator data that may legitimately be absent.
   */
  async list(): Promise<PlatformLink[]> {
    const rows = await this.db.select().from(platformLinks);
    const byKey = new Map(rows.map((r) => [r.key, r]));

    return PLATFORM_KEYS.map((key) => {
      const row = byKey.get(key);
      return {
        key,
        url: row?.url ?? null,
        updatedAt: row?.updatedAt ? row.updatedAt.toISOString() : null,
      };
    });
  }

  /**
   * Set or clear one platform's link.
   *
   * An empty string CLEARS it rather than storing `''`. "Take the broken link
   * down" is a thing an operator needs to do in a hurry, and making them find a
   * separate delete control for it is how a dead link stays up. A cleared link
   * renders as "not available yet", which is the truth.
   */
  async set(key: string, url: string | null, admin: Admin): Promise<PlatformLink> {
    if (!isPlatformKey(key)) {
      // Named explicitly. A 404 here would suggest the row is missing and might
      // appear later, when in fact no such platform exists.
      throw new ValidationError(
        `Unknown platform '${key}'. Expected one of: ${PLATFORM_KEYS.join(', ')}.`,
      );
    }

    const trimmed = url?.trim() ?? '';
    const value = trimmed === '' ? null : trimmed;

    if (value !== null) assertSafeDownloadUrl(value);

    const now = new Date();
    await this.db
      .insert(platformLinks)
      .values({ key, url: value, updatedBy: admin.id, updatedAt: now })
      // Upsert, because the rows are not seeded by a migration — a platform
      // nobody has configured has no row at all, and `list()` fills it in.
      .onConflictDoUpdate({
        target: platformLinks.key,
        set: { url: value, updatedBy: admin.id, updatedAt: now },
      });

    this.logger.log(
      value === null
        ? `Platform link '${key}' cleared by ${admin.email}`
        : `Platform link '${key}' set by ${admin.email}`,
    );

    return { key, url: value, updatedAt: now.toISOString() };
  }

  /** One link, for the rare caller that wants a single platform. */
  async get(key: PlatformKey): Promise<PlatformLink> {
    const [row] = await this.db
      .select()
      .from(platformLinks)
      .where(eq(platformLinks.key, key))
      .limit(1);
    return {
      key,
      url: row?.url ?? null,
      updatedAt: row?.updatedAt ? row.updatedAt.toISOString() : null,
    };
  }
}

/**
 * Refuse a URL the portal would render as a link.
 *
 * This value is written by an admin and then handed to every client as an
 * `href`. `javascript:` in an anchor executes on click, in the client's session,
 * on the portal's origin — so an admin account (or anything that compromises
 * one) could turn the downloads page into stored XSS against every client who
 * visits it. `data:` is the same trick wearing a different scheme.
 *
 * Parsed rather than pattern-matched, because the browser's parser is the
 * authority on what a string navigates to and hand-rolled checks keep losing to
 * it — the same reasoning as `safeReturnTo` on the portal side.
 *
 * Only `https:` is allowed. Not `http:`: this link is how a client obtains an
 * executable, and offering that over a channel anyone on the path can rewrite
 * defeats the point of hosting the download at all.
 */
export function assertSafeDownloadUrl(raw: string): void {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new ValidationError(
      'That is not a complete URL. Include the scheme, for example https://downloads.example.com/app.dmg',
    );
  }

  if (parsed.protocol !== 'https:') {
    throw new ValidationError(
      `Download links must use https. '${parsed.protocol}' is not allowed — clients install what they fetch from here.`,
    );
  }
}
