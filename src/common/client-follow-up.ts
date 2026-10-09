import { FieldValidationError, ValidationError } from './errors/domain-errors';

/**
 * A client's Follow-up and Result (0212) — the pure rules, shared by the write
 * path and the clients list. No Nest, no database.
 */

/** The most either note may hold, in characters — `client_followups_*_ck`. */
export const FOLLOW_UP_MAX_LENGTH = 2000;

/**
 * A note as it is stored: line endings unified, NUL removed (Postgres `text`
 * refuses it, which would be a 500), surrounding space trimmed — and an empty
 * note is NULL, the one spelling of "nothing" the CHECK constraints allow.
 */
export function noteText(value: string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  const text = value.replace(/\r\n?/g, '\n').replace(/\0/g, '').trim();
  return text === '' ? null : text;
}

/** How far back a NEWLY chosen follow-up date may lie: earlier today, wherever "today" is. */
const PAST_GRACE_MS = 24 * 60 * 60 * 1000;
/** How far ahead it may lie. A date past this is a typo (2062 for 2026), not a plan. */
const FUTURE_LIMIT_MS = 5 * 366 * 24 * 60 * 60 * 1000;

/**
 * The follow-up date, when it CHANGED. An unchanged date is never re-judged: a
 * follow-up that has since become overdue must not stop anyone saving the notes
 * beside it.
 */
export function assertFollowUpDate(at: Date, now: Date): void {
  if (Number.isNaN(at.getTime())) {
    throw new FieldValidationError('Choose a valid follow-up date.', {
      followUpAt: 'Choose a valid follow-up date.',
    });
  }
  if (at.getTime() < now.getTime() - PAST_GRACE_MS) {
    throw new FieldValidationError('The follow-up date is in the past.', {
      followUpAt: 'Choose today or a later date.',
    });
  }
  if (at.getTime() > now.getTime() + FUTURE_LIMIT_MS) {
    throw new FieldValidationError('The follow-up date is more than five years away.', {
      followUpAt: 'Choose a date within the next five years.',
    });
  }
}

/** The clients list's follow-up filter (`?followUp=`). */
export const FOLLOW_UP_FILTERS = ['due', 'upcoming', 'none'] as const;
export type FollowUpFilter = (typeof FOLLOW_UP_FILTERS)[number];

/**
 * `due`: a follow-up date before the reader's cut-off (`followUpDueBy`, the end
 * of THEIR today — only their browser knows when that is; now when omitted).
 * `upcoming`: a date at or after it. `none`: no date. Anything else is a 400,
 * never a silently unfiltered list (R-2.5).
 */
export function followUpFilter(value: string | undefined): FollowUpFilter | undefined {
  if (value === undefined || value === '') return undefined;
  if ((FOLLOW_UP_FILTERS as readonly string[]).includes(value)) return value as FollowUpFilter;
  throw new ValidationError(
    `Cannot filter by follow-up "${value}". Allowed: ${FOLLOW_UP_FILTERS.join(', ')}.`,
  );
}
