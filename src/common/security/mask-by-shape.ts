import 'reflect-metadata';
import {
  clientFieldMapOthersOf,
  clientFieldMapsOf,
  clientFieldsOf,
} from './client-field.decorator';
import type { FieldMask } from './field-mask';

/**
 * Apply an RBAC-03 mask to a response by walking its declared SHAPE.
 *
 * The counterpart to `applyMask`, and the difference is where the paths come
 * from. `applyMask` reads a hand-maintained alias list keyed by surface;
 * this reads the DTO the route already declares, so a value is masked wherever
 * that DTO appears — including on routes written after the field was marked.
 *
 * ## Rules, and why each one is here
 *
 * NON-MUTATING, like `applyMask`, and for the same reason: rows arrive straight
 * from Drizzle and may be shared with an audit write or a cache. Only the
 * objects along a masked path are cloned.
 *
 * A MISSING FIELD IS NOT AN ERROR. The same DTO describes a list row and a
 * detail, and the list row simply has fewer fields. Throwing would turn "this
 * admin cannot see phone numbers" into a 500 on the one screen that never
 * showed one.
 *
 * ARRAYS ARE WALKED ELEMENT BY ELEMENT. This is the case that has actually
 * leaked: `client.referredClients[].email` shipped a scoped admin's whole
 * downline until `removePath` learned to walk arrays. An element type cannot be
 * recovered from `design:type` (TypeScript emits `Array`), so it is taken from
 * the `@ApiProperty({ type: [X] })` the DTO already declares — which is why
 * `arrayElementType` prefers Swagger's metadata over the emitted one.
 *
 * CYCLES TERMINATE. A DTO graph can be recursive (a partner has a parent who is
 * a partner). Visited pairs are tracked, so a cycle costs a lookup rather than
 * a stack.
 *
 * NULL AND UNDEFINED PASS THROUGH UNTOUCHED, so "has none" keeps reading
 * differently from "may not see" — the distinction `maskedFields` exists to
 * preserve on the screen.
 */

const SWAGGER_PROPERTIES = 'swagger/apiModelProperties';

/** The class of property `key` on `type`, if the emitted metadata names one. */
export function propertyType(type: unknown, key: string): unknown {
  if (typeof type !== 'function') return undefined;
  return Reflect.getMetadata('design:type', (type as { prototype: object }).prototype, key);
}

/**
 * The class behind property `key`, as `@ApiProperty` declared it.
 *
 * `design:type` is useless for arrays — TypeScript emits `Array` and says
 * nothing about the elements — and this is the case that has actually leaked:
 * `client.referredClients[].email` shipped a scoped admin's whole downline
 * until `removePath` learned to walk arrays. So the element type is read from
 * the metadata the DTOs already carry for Swagger's benefit.
 *
 * Two details of that metadata, both easy to get wrong and both load-bearing:
 * Nest stores it as `(key, prototype, property)` rather than under a composed
 * key, and `getTypeIsArrayTuple` has ALREADY unwrapped `type: [X]` into
 * `type: X` with a separate `isArray` — so an `Array.isArray` check here never
 * matches, which is precisely how the first version of this silently masked
 * nothing inside arrays while passing every scalar case.
 */
export function declaredType(type: unknown, key: string): unknown {
  if (typeof type !== 'function') return undefined;
  const proto = (type as { prototype: object }).prototype;
  const declared = Reflect.getMetadata(SWAGGER_PROPERTIES, proto, key) as
    { type?: unknown } | undefined;

  let candidate = declared?.type;
  // `type: () => X` — a thunk, used where the reference would be circular.
  if (typeof candidate === 'function' && !(candidate as { prototype?: unknown }).prototype) {
    candidate = (candidate as () => unknown)();
  }
  if (Array.isArray(candidate)) candidate = candidate[0];
  return candidate;
}

/**
 * A copy of `value` with every field marked `@ClientField(k)` removed, for each
 * `k` present in `mask`.
 *
 * @param shape the DTO class describing `value`. Without one nothing is masked
 *   — which is deliberate and is the reason a route must declare its response
 *   type: an undeclared shape is a shape this cannot protect, and that has to
 *   be visible rather than silently safe-looking.
 */
export function maskByShape<T>(shape: unknown, value: T, mask: FieldMask): T {
  return maskByShapeReporting(shape, value, mask).value;
}

/**
 * `maskByShape`, and the catalogue keys it actually removed from THIS value —
 * what a response's `maskedFields` must report so a screen can say "hidden"
 * rather than "none" (D-82). A key the mask holds but no row carried is not
 * reported: nothing was hidden.
 */
export function maskByShapeReporting<T>(
  shape: unknown,
  value: T,
  mask: FieldMask,
): { value: T; removed: string[] } {
  if (mask.length === 0 || shape === undefined || shape === null) return { value, removed: [] };
  const removed = new Set<string>();
  const masked = walk(shape, value, new Set(mask), new Set(), removed) as T;
  return { value: masked, removed: [...removed] };
}

function walk(
  shape: unknown,
  value: unknown,
  hidden: ReadonlySet<string>,
  seen: Set<string>,
  removed: Set<string>,
): unknown {
  if (value === null || value === undefined || typeof value !== 'object') return value;

  if (Array.isArray(value)) {
    let changed = false;
    const next = value.map((entry) => {
      const masked = walk(shape, entry, hidden, seen, removed);
      if (masked !== entry) changed = true;
      return masked;
    });
    return changed ? next : value;
  }

  const fields = clientFieldsOf(shape);
  const row = value as Record<string, unknown>;
  let result = row;
  let cloned = false;

  const replace = (key: string, next: unknown): void => {
    if (!cloned) {
      result = { ...row };
      cloned = true;
    }
    if (next === undefined) delete result[key];
    else result[key] = next;
  };

  for (const [property, catalogueKey] of fields) {
    if (hidden.has(catalogueKey) && property in row) {
      replace(property, undefined);
      removed.add(catalogueKey);
    }
  }

  /*
   * Free-form maps, keyed by CATALOGUE PREFIX rather than by declared property.
   *
   * `personalInfo` is `Record<string, string>` because the KYC builder lets an
   * operator add fields, so there are no declared properties to walk and the
   * loop above finds nothing — while the catalogue masks four keys inside it.
   * Removing by `<prefix>.<key>` reaches them whatever they are called,
   * including fields added after this was written.
   */
  const othersOf = clientFieldMapOthersOf(shape);
  for (const [property, prefix] of clientFieldMapsOf(shape)) {
    const map = row[property];
    if (map === null || typeof map !== 'object' || Array.isArray(map)) continue;

    const entries = map as Record<string, unknown>;
    // A key the catalogue does not name — a broker's own question — is hidden
    // by the map's `others` key (see `ClientFieldMap`), never left unmaskable.
    const others = othersOf.get(property);
    const hidesOthers = others !== undefined && hidden.has(others.others);
    const doomed = Object.keys(entries).filter(
      (key) => hidden.has(`${prefix}.${key}`) || (hidesOthers && !others.named.includes(key)),
    );
    if (doomed.length === 0) continue;
    for (const key of doomed) {
      removed.add(hidden.has(`${prefix}.${key}`) || !others ? `${prefix}.${key}` : others.others);
    }

    const kept: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(entries)) {
      if (!doomed.includes(key)) kept[key] = value;
    }
    replace(property, kept);
  }

  for (const key of Object.keys(row)) {
    if (cloned && !(key in result)) continue;
    const child = row[key];
    if (child === null || typeof child !== 'object') continue;

    /*
     * The DECLARED type wins over the emitted one. For an array the emitted
     * type is `Array`; for a nested object the two agree, and where they do not
     * it is because `@ApiProperty` was given an explicit type, which is the
     * more specific statement of the two.
     */
    const childShape = declaredType(shape, key) ?? propertyType(shape, key);
    if (typeof childShape !== 'function') continue;

    /*
     * One visit per (shape, property) pair. A recursive DTO graph would
     * otherwise recurse until the stack gives out, and the values below a
     * repeat are the same shape that was already handled.
     */
    const token = `${(shape as { name?: string }).name ?? '?'}.${key}`;
    if (seen.has(token)) continue;
    seen.add(token);
    const masked = walk(childShape, child, hidden, seen, removed);
    seen.delete(token);

    if (masked !== child) replace(key, masked);
  }

  return result;
}
