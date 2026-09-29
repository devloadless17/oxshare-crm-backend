import { PROFILE_FIELD_KEYS } from '../profile/client-profile';
import { HIDDEN, HIDDEN_TEXT } from './mask-by-shape';

/**
 * Which keys inside `audit_log.details` carry a CLIENT-OWNED value, per action.
 *
 * ## Why a declaration and not a heuristic
 *
 * `details` is free-form `jsonb`. It has no DTO, so the response interceptor has
 * nothing to walk, and no catalogue path, so `applyMask` cannot reach inside it
 * either — it was the one store in the system nothing could mask. Most of what
 * was in there was denormalised context and simply removed: `subject_id` on
 * those rows already IS the client, so the address made the row no more
 * answerable and only spread PII somewhere it could not be taken back out of.
 *
 * `client.email_change` is the case that cannot be solved that way. There the
 * two addresses ARE the change, and a record of an email change that does not
 * say which emails is not a record of anything.
 *
 * So the values stay, and the READ is masked instead. The obvious implementation
 * — scan the JSON for anything that looks like an address — is the one to avoid:
 * it would hide a reference that happens to contain an `@`, miss a phone number
 * entirely, and quietly change behaviour whenever somebody adds a detail key.
 * Naming the keys makes it a statement somebody wrote down, checkable against
 * the writer a few lines away in `admin-clients.service.ts`.
 *
 * ## What this does NOT weaken
 *
 * The row is still WRITTEN in full, and `audit_log` is still append-only by
 * trigger. What a masked reader sees is narrowed; what the system recorded is
 * not. An investigator with the field unmasked reads the whole thing, which is
 * the difference between a redacted VIEW and a redacted RECORD — only the first
 * is compatible with the log being evidence.
 */
/**
 * What a declared detail key holds: ONE client-owned value (its catalogue key),
 * or an OBJECT of profile fields, each with its own — the `{ before: {…},
 * after: {…} }` shape every profile change writes.
 */
export type AuditDetailDeclaration = string | Readonly<Record<string, string>>;

/**
 * Each profile field's catalogue key (`client.<field>`, as `client-fields.json`
 * names them), for the nested before/after maps below.
 *
 * ## Why the profile actions are declared now
 *
 * `client.profile_update` wrote `{ before, after }` holding names, phones and
 * countries from the day it existed, and nothing declared them — so an operator
 * masked from a client's phone read it in the audit log, the one screen that
 * lists every change. 0139 put date of birth, nationality and the address into
 * the same rows, which made the gap worth a census rather than a comment. Each
 * FIELD is masked on its own: a reader allowed the name but not the date of
 * birth sees the rename and not the birthday.
 */
const PROFILE_DETAIL_FIELDS: Readonly<Record<string, string>> = Object.fromEntries(
  PROFILE_FIELD_KEYS.map((field) => [field, `client.${field}`]),
);

export const AUDIT_DETAIL_FIELDS: Readonly<
  Record<string, Readonly<Record<string, AuditDetailDeclaration>>>
> = {
  'client.email_change': { before: 'client.email', after: 'client.email' },
  'client.profile_update': { before: PROFILE_DETAIL_FIELDS, after: PROFILE_DETAIL_FIELDS },
  'kyc.identity_correct': { before: PROFILE_DETAIL_FIELDS, after: PROFILE_DETAIL_FIELDS },
  'client.profile_consolidated': {
    before: PROFILE_DETAIL_FIELDS,
    after: PROFILE_DETAIL_FIELDS,
    discarded: PROFILE_DETAIL_FIELDS,
  },
};

/**
 * A copy of `details` without the keys this reader may not see.
 *
 * Non-mutating, like every other mask in this system: the row it is given may be
 * shared with a cache or a serialiser, and masking in place would make what got
 * hidden depend on which consumer ran first.
 */
export function maskAuditDetails<T>(
  action: string,
  details: T,
  mask: readonly string[],
  /** Written where a value was, for a FILE; omitted on a screen, where the key goes. */
  placeholder?: string,
): T {
  const declared = AUDIT_DETAIL_FIELDS[action];
  if (!declared || details === null || typeof details !== 'object' || Array.isArray(details)) {
    return details;
  }

  const hidden = new Set(mask);
  let narrowed = false;
  const kept: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(details as Record<string, unknown>)) {
    const declaration = declared[key];
    if (declaration === undefined) {
      kept[key] = value;
    } else if (typeof declaration === 'string') {
      // One value, one catalogue key: withheld whole.
      if (hidden.has(declaration)) {
        narrowed = true;
        if (placeholder !== undefined) kept[key] = placeholder;
      } else kept[key] = value;
    } else if (value === null || typeof value !== 'object' || Array.isArray(value)) {
      kept[key] = value;
    } else {
      // An object of fields: each withheld on its own key, the rest kept.
      const inner: Record<string, unknown> = {};
      for (const [field, fieldValue] of Object.entries(value as Record<string, unknown>)) {
        const catalogueKey = declaration[field];
        if (catalogueKey !== undefined && hidden.has(catalogueKey)) {
          narrowed = true;
          if (placeholder !== undefined) inner[field] = placeholder;
        } else inner[field] = fieldValue;
      }
      kept[key] = inner;
    }
  }
  return (narrowed ? kept : details) as T;
}

/**
 * The catalogue key for a client's address, named once so the two places that
 * consult it cannot disagree about its spelling.
 */
const CLIENT_EMAIL = 'client.email';
/** …and for the address a client acted from (D-82). */
const CLIENT_IP = 'client.ipAddress';

/** The parts of an audit row this module is allowed to narrow. */
export type AuditMaskableRow = {
  action: string;
  actorKind?: string | null;
  actorEmail?: string | null;
  ipAddress?: string | null;
  details?: unknown;
};

/**
 * A copy of an audit row with BOTH of its client-owned parts narrowed: the
 * declared `details` keys above, and the actor's own address when THE ACTOR IS
 * A CLIENT.
 *
 * ## The actor-email half, and why it was missing
 *
 * `AuditEntryDto.actorEmail` is declared `@NotClientField` with the reason
 * "the ACTOR who performed the action, an administrator; a client field mask
 * has no standing over it". That was true of the table as first written — and
 * `actorKind` was added to THAT SAME CLASS precisely because it stopped being
 * true. Its own comment opens "The table assumed an admin" and enumerates
 * `admin | client | system | provider`. The masking sentence three lines above
 * it was never revisited.
 *
 * So a fully-masked operator could download `/admin/audit-log/export` and read
 * client addresses straight out of the `Actor email` column. Found by
 * `masking-adversarial.spec.ts`, which fetches the file through that operator's
 * own session rather than asserting about it in-process.
 *
 * ## Why it cannot be a decorator
 *
 * The answer depends on a SIBLING field. `maskByShape` walks a shape and
 * decides per field with no view of the row, so it can express "this field is
 * client-owned" but not "this field is client-owned when that one says
 * `client`". Exactly the reason `details` is handled here rather than declared.
 *
 * ## What stays readable, deliberately
 *
 * An `admin`, `system` or `provider` actor is not client-owned and is NOT
 * masked. Hiding it would empty the column that answers "who did this", which
 * is the entire purpose of the log — the mask narrows whose PII an operator can
 * harvest, not whose accountability it can see.
 *
 * One definition, both call sites: the list read and the CSV batch call THIS,
 * so the export cannot drift from the screen. That asymmetry is not
 * hypothetical here — it is how the withdrawal desk leaked for seventeen days
 * after its own list was fixed.
 */
export function maskAuditRow<T extends AuditMaskableRow>(
  row: T,
  mask: readonly string[],
  /**
   * `'file'` for the CSV export: a hidden value becomes `HIDDEN` (the actor's
   * email and IP, which the writer prints `[hidden]`) or the text `[hidden]`
   * (inside the details JSON), never a gap that reads as "none" (D-82).
   */
  target: 'screen' | 'file' = 'screen',
): T {
  const file = target === 'file';
  const out: Record<string, unknown> = {
    ...row,
    details: maskAuditDetails(row.action, row.details, mask, file ? HIDDEN_TEXT : undefined),
  };
  const clientActor = row.actorKind === 'client';
  if (clientActor && mask.includes(CLIENT_EMAIL)) {
    if (file) out.actorEmail = HIDDEN;
    else delete out.actorEmail;
  }
  // The screen's read already nulls a hidden client IP (`AuditLogStore`); a file
  // says it was hidden rather than absent.
  if (file && clientActor && mask.includes(CLIENT_IP)) out.ipAddress = HIDDEN;
  return out as T;
}
