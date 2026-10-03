import { systemSentenceArabic } from '../../common/i18n/reason-arabic';
import type { RejectionReasonsStore } from '../../store/rejection-reasons.store';

/** A money movement as a client reads it, as far as its reason is concerned. */
interface ReasonRow {
  direction: string;
  /** `payment` | `transfer` | `rebate` | `commission_transfer`; absent = a payment. */
  kind?: string;
  rejectionReason?: string | null;
  rejectionReasonAr?: string | null;
}

/**
 * `rejectionReasonAr` on every refused movement a client reads (0179, 3 Oct 2026),
 * in ONE order of preference:
 *
 *   1. the Arabic written WITH the decision (`rejection_reason_ar`) — what the
 *      client was told, whatever the catalogue says now;
 *   2. the configured reason's Arabic, when the stored text is one (or
 *      "label — note") — rows decided before the column existed;
 *   3. the catalogue's Arabic of a sentence the system wrote.
 *
 * ONE catalogue query for the whole page, and none when no row needs it. A row
 * with nothing to offer carries no key at all — absent, never null or blank.
 */
export async function withReasonArabicRows<T extends ReasonRow>(
  rows: readonly T[],
  reasons: RejectionReasonsStore,
): Promise<(T & { rejectionReasonAr?: string })[]> {
  const contextOf = (row: ReasonRow) =>
    (row.kind ?? 'payment') !== 'payment'
      ? undefined
      : row.direction === 'deposit'
        ? ('deposit' as const)
        : row.direction === 'withdrawal'
          ? ('withdrawal' as const)
          : undefined;
  const stored = (row: ReasonRow) =>
    typeof row.rejectionReasonAr === 'string' && row.rejectionReasonAr.trim() !== ''
      ? row.rejectionReasonAr
      : undefined;

  const needing = rows.filter((row) => row.rejectionReason && !stored(row) && contextOf(row));
  const arabicOf =
    needing.length > 0 ? await reasons.arabicFor(needing.map((row) => contextOf(row)!)) : undefined;

  return rows.map((row) => {
    const { rejectionReasonAr: _stored, ...rest } = row;
    const context = contextOf(row);
    const arabic =
      stored(row) ??
      (row.rejectionReason
        ? ((context && arabicOf?.(context, row.rejectionReason)) ??
          systemSentenceArabic(row.rejectionReason) ??
          undefined)
        : undefined);
    return (arabic ? { ...rest, rejectionReasonAr: arabic } : rest) as T & {
      rejectionReasonAr?: string;
    };
  });
}
