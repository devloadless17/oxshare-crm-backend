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
export const AUDIT_DETAIL_FIELDS: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  'client.email_change': { before: 'client.email', after: 'client.email' },
};

/**
 * A copy of `details` without the keys this reader may not see.
 *
 * Non-mutating, like every other mask in this system: the row it is given may be
 * shared with a cache or a serialiser, and masking in place would make what got
 * hidden depend on which consumer ran first.
 */
export function maskAuditDetails<T>(action: string, details: T, mask: readonly string[]): T {
  const declared = AUDIT_DETAIL_FIELDS[action];
  if (!declared || details === null || typeof details !== 'object' || Array.isArray(details)) {
    return details;
  }

  const hidden = new Set(mask);
  const row = details as Record<string, unknown>;
  const doomed = Object.keys(row).filter((key) => {
    const catalogueKey = declared[key];
    return catalogueKey !== undefined && hidden.has(catalogueKey);
  });
  if (doomed.length === 0) return details;

  const kept: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(row)) {
    if (!doomed.includes(key)) kept[key] = value;
  }
  return kept as T;
}
