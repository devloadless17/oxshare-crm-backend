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

/**
 * A copy of `row` with this mask's fields removed.
 *
 * Non-mutating, and that matters more than it looks: rows arrive straight from
 * Drizzle and may be shared across a response, a cache or a subsequent audit
 * write. Deleting in place would make what got MASKED depend on the order the
 * consumers ran in, which is the kind of bug that only appears under load.
 *
 * Only the objects along a masked path are cloned; everything else is shared by
 * reference. Masking three fields on a 25-row page should not deep-copy 25 rows.
 *
 * A path that does not exist on the row is a no-op, deliberately. The same mask
 * is applied to a list row and to a full profile, and the list row simply has
 * fewer fields — that is not an error, and throwing would turn "this admin
 * cannot see phone numbers" into a 500 on the one screen that never showed one.
 */
export function applyMask<T>(resource: string, row: T, mask: FieldMask): T {
  const paths = maskedPathsFor(resource, mask);
  if (paths.length === 0 || row === null || typeof row !== 'object') return row;

  let result = row as Record<string, unknown>;
  let cloned = false;

  for (const path of paths) {
    const segments = path.split('.');
    const next = removePath(result, segments, cloned);
    if (next !== result) {
      result = next;
      cloned = true;
    }
  }

  return result as T;
}

/** Applies the mask across a page of rows. */
export function applyMaskAll<T>(resource: string, rows: readonly T[], mask: FieldMask): T[] {
  const paths = maskedPathsFor(resource, mask);
  if (paths.length === 0) return rows as T[];
  return rows.map((row) => applyMask(resource, row, mask));
}

/**
 * Removes `segments` from `source`, cloning only the objects on that path.
 *
 * Returns `source` unchanged when the path is absent, which is what lets the
 * caller skip cloning entirely for a mask that touches nothing on this shape.
 */
function removePath(
  source: Record<string, unknown>,
  segments: string[],
  alreadyCloned: boolean,
): Record<string, unknown> {
  const [head, ...rest] = segments;

  if (rest.length === 0) {
    if (!(head in source)) return source;
    const copy = alreadyCloned ? source : { ...source };
    delete copy[head];
    return copy;
  }

  const child = source[head];
  // A null or primitive part-way down the path is "the nested object is not
  // here", which is the same no-op as a missing key — not a reason to fail.
  if (child === null || typeof child !== 'object') return source;

  /*
   * AN ARRAY IS A BRANCH, NOT A DEAD END — and this line used to return
   * `source`, which made every field inside a list UNMASKABLE BY CONSTRUCTION.
   *
   * That is not a theoretical hole. `client.referredClients[].email` was
   * shipping a scoped admin's whole downline — up to fifty names and email
   * addresses — to somebody whose every screen withholds exactly those fields,
   * and no alias could have fixed it: the walk gave up before it reached them.
   *
   * `a.b.email` over a list means "that field on EVERY element", which is the
   * only reading that makes a mask a mask. Applied elementwise, cloning only
   * the elements that actually change, so a list nothing touches is returned
   * by identity exactly as before and the no-op case stays free.
   */
  if (Array.isArray(child)) {
    let changed = false;
    /*
     * `unknown[]`, not the `any[]` `Array.isArray` narrows to. Every element
     * here is data from a response being masked, and an `any` flowing back out
     * of this map is exactly the shape that let a field inside a list go
     * unmasked in the first place.
     */
    const next = (child as unknown[]).map((item) => {
      if (item === null || typeof item !== 'object' || Array.isArray(item)) return item;
      const masked = removePath(item as Record<string, unknown>, rest, false);
      if (masked !== item) changed = true;
      return masked;
    });
    if (!changed) return source;

    const copy = alreadyCloned ? source : { ...source };
    copy[head] = next;
    return copy;
  }

  const nextChild = removePath(child as Record<string, unknown>, rest, false);
  if (nextChild === child) return source;

  const copy = alreadyCloned ? source : { ...source };
  copy[head] = nextChild;
  return copy;
}
