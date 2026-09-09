/**
 * RBAC-03 field masking — removing values an administrator may not see, at the
 * last point before they become JSON.
 *
 * A PURE SEAM, in the sense ARCHITECTURE §8.6 uses for `commission.ts` and
 * `money.ts`: no Nest, no Drizzle, no database, no HTTP. That is not tidiness.
 * This is the function standing between a support agent and a client's phone
 * number, and it has to be exhaustively testable without a container — every
 * shape it can be handed, every path that does not exist, every value that is
 * legitimately absent.
 *
 * ── The wire contract ───────────────────────────────────────────────────────
 *
 * A masked field is OMITTED, not nulled and not replaced with a sentinel. Null
 * is already meaningful ("this client has no phone number on file"), and a
 * sentinel string would be a value the frontend has to remember never to
 * display, compare or format. Omission plus a sibling `maskedFields: string[]`
 * on the response gives the UI the one distinction it actually needs — hidden
 * from you, versus genuinely empty — without overloading a value.
 *
 * `maskedFields` is a property of the VIEWER, not of a row: every row in a
 * response carries the same set, so it is sent once at the top rather than
 * repeated per item.
 *
 * ── Key shape ───────────────────────────────────────────────────────────────
 *
 * Catalog keys are `<resource>.<path.within.the.dto>` — `client.email`,
 * `kyc.personalInfo.phone`. The resource prefix is what lets one mask cover
 * several DTOs without a flat `country` hiding `users.country` while leaking
 * the country inside a KYC submission's JSON. See `config/client-fields.json`.
 */

/** The keys an administrator may not see, already expanded with their aliases. */
export type FieldMask = readonly string[];

/** Nothing hidden — a master admin, and the default for everybody else. */
export const EMPTY_MASK: FieldMask = Object.freeze([]);

/**
 * The DTO paths this mask hides within `resource`, with the prefix stripped.
 *
 * `('client', ['client.email', 'kyc.personalInfo.phone'])` → `['email']`.
 */
export function maskedPathsFor(resource: string, mask: FieldMask): string[] {
  const prefix = `${resource}.`;
  return mask.filter((key) => key.startsWith(prefix)).map((key) => key.slice(prefix.length));
}

/**
 * The masked keys that apply to `resource`, prefix intact — what goes on the
 * response as `maskedFields` so the UI can say "hidden" rather than "—".
 */
export function maskedFieldsFor(resource: string, mask: FieldMask): string[] {
  const prefix = `${resource}.`;
  return mask.filter((key) => key.startsWith(prefix));
}
