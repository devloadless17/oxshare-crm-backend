import { arabicText } from '../dto/arabic-text';
import { localizeMessage } from './localize-message';

/**
 * THE ARABIC OF A REASON, decided ONCE — when the reason is written (3 Oct 2026).
 *
 * A reason a client reads is stored as a copy beside the decision (`rejection_reason`
 * and friends), and its Arabic is now stored beside it (`*_ar`). It is composed here,
 * the same way the English is composed by every desk — a configured label,
 * optionally followed by the reviewer's own note, joined by " — ":
 *
 * | given                                   | stored Arabic                          |
 * | --------------------------------------- | -------------------------------------- |
 * | the reviewer's own Arabic (`noteAr`)    | `<label in Arabic, else English> — <noteAr>`, or `noteAr` alone |
 * | a configured label with Arabic, no note | `<labelAr>`                             |
 * | a configured label with Arabic + note   | `<labelAr> — <note as typed>`           |
 * | nothing translated                      | null — the reader falls back           |
 *
 * The configured label's Arabic is copied AS IT READS NOW, so a later edit of the
 * catalogue cannot change what a client was told — the reason the English is a
 * copy in the first place. Null means "no Arabic": a reader then tries the
 * catalogue (`RejectionReasonsStore.arabicFor`), then shows the English.
 */
export function composeReasonArabic(input: {
  /** The configured reason's English label, when one was chosen. */
  label?: string | null;
  /** That label's Arabic, when the catalogue has it. */
  labelAr?: string | null;
  /** The reviewer's own words in English (or as typed). */
  note?: string | null;
  /** The reviewer's own words in Arabic. */
  noteAr?: string | null;
}): string | null {
  const label = input.label?.trim() || null;
  const labelAr = arabicText(input.labelAr);
  const note = input.note?.trim() || null;
  const noteAr = arabicText(input.noteAr);

  if (!label) return noteAr;
  if (!labelAr && !noteAr) return null;
  const head = labelAr ?? label;
  const tail = noteAr ?? note;
  return tail ? `${head} — ${tail}` : head;
}

/**
 * The Arabic of a sentence the SYSTEM writes as a reason ("The payment provider
 * could not complete this withdrawal.") — from the server-message catalogue, or
 * null when it has none. Stored with the English so a reader needs no lookup.
 */
export function systemSentenceArabic(text: string | null | undefined): string | null {
  if (typeof text !== 'string' || text.trim() === '') return null;
  const arabic = localizeMessage(text, 'ar');
  return arabic !== text ? arabic : null;
}

/**
 * A rebate's NAME in a client's history, in Arabic (3 Oct 2026) — the movements
 * union names it "Rebate", or "Rebate · 40 trades" for a batched payout, in SQL.
 * `methodNameAr` beside `methodName`, so the portal shows the count in Arabic
 * too rather than a bare label of its own. Null for anything that is not one.
 */
export function rebateNameArabic(kind: string, methodName: string | null): string | null {
  if (kind !== 'rebate' || methodName === null) return null;
  if (methodName === 'Rebate') return 'العمولة المستردة';
  const batch = /^Rebate · (\d+) trades$/.exec(methodName);
  if (!batch) return null;
  const count = Number(batch[1]);
  // Arabic counts its noun: 2 → dual, 3–10 → plural, 11+ → singular accusative.
  const trades =
    count === 2 ? 'صفقتان' : count >= 3 && count <= 10 ? `${count} صفقات` : `${count} صفقة`;
  return `العمولة المستردة · ${trades}`;
}
