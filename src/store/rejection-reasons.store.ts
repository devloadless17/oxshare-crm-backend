import { and, eq, inArray, isNotNull } from 'drizzle-orm';
import { Inject, Injectable } from '@nestjs/common';
import { DRIZZLE_DB } from '../database/database.module';
import type { Db } from '../database/db';
import { rejectionReasons } from '../database/schema';
import { systemSentenceArabic } from '../common/i18n/reason-arabic';

// FR-ADM-03: rejection of a withdrawal or verification request is accompanied
// by "a reason from a configurable list". Defaults are seeded idempotently in
// src/database/seed.ts (UNIQUE(context, label) makes re-seeding a no-op).
/*
 * DERIVED from the enum rather than restated.
 *
 * This was a hand-written union and it went stale the moment 'partner' was
 * added to `rejection_context` — the store then returned rows the type said
 * could not exist, and tsc pointed at the assignment rather than at the union.
 * Reading it off the column means the next context added to the schema is a
 * type error at every switch that does not handle it, which is where the
 * mismatch is worth surfacing.
 */
export type RejectionContext = (typeof rejectionReasons.context.enumValues)[number];

export interface RejectionReason {
  id: string;
  context: RejectionContext;
  label: string;
  /** What a client reading the portal in Arabic is shown (0179); null = not translated. */
  labelAr: string | null;
  createdAt: Date;
}

/**
 * The Arabic of a reason as a CLIENT reads it: the stored reason text — a copy,
 * taken when the decision was made — and the context it was decided in. Present
 * only when that text is, word for word, a configured reason of that context
 * which has Arabic; a reviewer's own wording has no translation, and the
 * client reads it as written.
 */
export type ReasonArabic = (
  context: RejectionContext,
  text: string | null | undefined,
) => string | undefined;

/** A view whose stored Arabic is null/blank, without the key — absent, not null, on the wire. */
function withoutBlankArabic<T extends { rejectionReasonAr?: string | null }>(
  view: T,
): T & { rejectionReasonAr?: string } {
  if (!('rejectionReasonAr' in view)) return view as T & { rejectionReasonAr?: string };
  if (typeof view.rejectionReasonAr === 'string' && view.rejectionReasonAr.trim() !== '') {
    return view as T & { rejectionReasonAr?: string };
  }
  const { rejectionReasonAr: _blank, ...rest } = view;
  return rest as T & { rejectionReasonAr?: string };
}

/** The resolver for nothing — what a read with no reason on it uses, at no query. */
export const NO_REASON_ARABIC: ReasonArabic = () => undefined;

@Injectable()
export class RejectionReasonsStore {
  constructor(@Inject(DRIZZLE_DB) private readonly db: Db) {}

  async findAll(context?: RejectionContext): Promise<RejectionReason[]> {
    const db = this.db;
    return context
      ? db.select().from(rejectionReasons).where(eq(rejectionReasons.context, context))
      : db.select().from(rejectionReasons);
  }

  async findById(id: string): Promise<RejectionReason | undefined> {
    const [row] = await this.db
      .select()
      .from(rejectionReasons)
      .where(eq(rejectionReasons.id, id))
      .limit(1);
    return row;
  }

  async create(
    context: RejectionContext,
    label: string,
    labelAr: string | null = null,
  ): Promise<RejectionReason> {
    const [row] = await this.db
      .insert(rejectionReasons)
      .values({ context, label, labelAr })
      .returning();
    return row;
  }

  /** `labelAr` undefined keeps the stored Arabic; null clears it. */
  async update(
    id: string,
    label: string,
    labelAr?: string | null,
  ): Promise<RejectionReason | undefined> {
    const [row] = await this.db
      .update(rejectionReasons)
      .set(labelAr === undefined ? { label } : { label, labelAr })
      .where(eq(rejectionReasons.id, id))
      .returning();
    return row;
  }

  /**
   * THE ONE LOOKUP behind every client read that shows a copied reason
   * (`rejectionReasonAr`, a notification's `reasonAr`): ONE query for every
   * context the page needs, however many rows it holds — never one per row.
   * Read on demand, not cached, so a reason translated a minute ago is served
   * on the next read on every instance.
   */
  /**
   * One record carrying a copied `rejectionReason`, with its Arabic beside it as
   * `rejectionReasonAr` when it has one. No reason, no query.
   */
  async withReasonArabic<
    T extends { rejectionReason?: string | null; rejectionReasonAr?: string | null },
  >(context: RejectionContext, view: T): Promise<T & { rejectionReasonAr?: string }> {
    if (!view.rejectionReason) return withoutBlankArabic(view);
    // The Arabic written WITH the decision wins: it is what the client was told.
    if (typeof view.rejectionReasonAr === 'string' && view.rejectionReasonAr.trim() !== '') {
      return view as T & { rejectionReasonAr?: string };
    }
    const arabic = (await this.arabicFor([context]))(context, view.rejectionReason);
    return arabic ? { ...view, rejectionReasonAr: arabic } : withoutBlankArabic(view);
  }

  async arabicFor(contexts: readonly RejectionContext[]): Promise<ReasonArabic> {
    const wanted = [...new Set(contexts)];
    if (wanted.length === 0) return NO_REASON_ARABIC;
    const rows = await this.db
      .select({
        context: rejectionReasons.context,
        label: rejectionReasons.label,
        labelAr: rejectionReasons.labelAr,
      })
      .from(rejectionReasons)
      .where(and(inArray(rejectionReasons.context, wanted), isNotNull(rejectionReasons.labelAr)));
    const byContext = new Map<string, Map<string, string>>();
    for (const row of rows) {
      const arabic = row.labelAr?.trim();
      if (!arabic) continue;
      const labels = byContext.get(row.context) ?? new Map<string, string>();
      labels.set(row.label, arabic);
      byContext.set(row.context, labels);
    }
    return (context, text) => {
      if (typeof text !== 'string' || text === '') return undefined;
      const labels = byContext.get(context);
      const exact = labels?.get(text);
      if (exact) return exact;
      // "label — reviewer's note": the label in Arabic, the note as typed.
      const separator = ' — ';
      for (let at = text.indexOf(separator); at > 0; at = text.indexOf(separator, at + 1)) {
        const label = labels?.get(text.slice(0, at));
        if (label) return `${label}${text.slice(at)}`;
      }
      // A sentence the SYSTEM wrote (a provider refusal, a closed deposit).
      return systemSentenceArabic(text) ?? undefined;
    };
  }

  async delete(id: string): Promise<boolean> {
    const deleted = await this.db
      .delete(rejectionReasons)
      .where(eq(rejectionReasons.id, id))
      .returning();
    return deleted.length > 0;
  }
}
