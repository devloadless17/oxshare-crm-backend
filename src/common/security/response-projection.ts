import 'reflect-metadata';
import { declaredType, propertyType } from './mask-by-shape';

/**
 * Hold a response to the shape its route declares: keep what the DTO names,
 * report everything else.
 *
 * A PURE SEAM, like `mask-by-shape.ts` beside it: no Nest, no HTTP, so every
 * shape it can be handed is a unit test.
 *
 * ## The failure this exists to make impossible
 *
 * `PATCH /admin/clients/:id/referrer` declared `ClientAccountDto` and returned
 * the raw `users` row — `passwordHash` and two token hashes — to any
 * administrator holding the permission (28 Sep 2026). The declaration was a
 * promise about the shape, and nothing held the body to it. Masking could not
 * have caught it either: it removes the fields a DTO MARKS, and a field the
 * DTO never declares is invisible to it. So the rule is the one
 * `response-completeness.spec.ts` asserted surface by surface, now applied to
 * every response by construction: **a key the declared shape does not name
 * does not leave the process.**
 *
 * ## Reading the declaration
 *
 * The declared properties are Swagger's own list (`@ApiProperty` on the class
 * and its ancestors), and a property's class is found the way the masking
 * walker finds it (`declaredType` / `propertyType`) — two walkers reading one
 * declaration two ways would be a drift waiting to happen.
 *
 * A property declared as a FREE-FORM map (`additionalProperties`, or `type:
 * 'object'`/`Object`) passes through whole: its keys are data, not shape — an
 * audit row's `details`, a notification's `params`. A value that is not a plain
 * object (a Date, a Buffer) passes through as it is.
 */

const PROPERTY_LIST = 'swagger/apiModelPropertiesArray';
const PROPERTY_META = 'swagger/apiModelProperties';

/** Constructors that name a VALUE type, never a shape to walk. */
const OPAQUE: ReadonlySet<unknown> = new Set<unknown>([
  String,
  Number,
  Boolean,
  Date,
  Object,
  Array,
  Buffer,
  BigInt,
  Symbol,
]);

export interface Projection<T> {
  /** The value with every undeclared key removed (the input itself if none were). */
  value: T;
  /** Where each undeclared key was found — `items[].passwordHash`, `referrer.active`. */
  undeclared: string[];
  /**
   * The body shares NO top-level key with its declared shape: a mis-declared
   * wrapper (`{ transaction, replayed }` under `TransactionDto`), not a leak. A
   * leak — a row with extra columns — always overlaps its DTO. Stripping this
   * would empty the response, so production passes it through and logs an
   * error instead; tests refuse it like any other undeclared key.
   */
  shapeMismatch: boolean;
}

/** The property names `type` declares, its ancestors' included, or undefined for no shape. */
function declaredPropertiesOf(type: unknown): ReadonlySet<string> | undefined {
  if (typeof type !== 'function' || OPAQUE.has(type)) return undefined;
  const prototype = (type as { prototype?: object }).prototype;
  if (!prototype) return undefined;
  // `@ApiProperty` appends to the INHERITED list when it writes, so the nearest
  // list on the chain already carries every ancestor's properties.
  const list = Reflect.getMetadata(PROPERTY_LIST, prototype) as string[] | undefined;
  return list ? new Set(list.map((key) => key.replace(/^:/, ''))) : undefined;
}

/** Declared as a map whose keys are data — walked no further. */
function isFreeForm(type: unknown, key: string): boolean {
  const prototype = (type as { prototype?: object }).prototype;
  if (!prototype) return false;
  const meta = Reflect.getMetadata(PROPERTY_META, prototype, key) as
    { type?: unknown; additionalProperties?: unknown } | undefined;
  return (
    meta?.additionalProperties !== undefined || meta?.type === 'object' || meta?.type === Object
  );
}

function isWalkable(value: object): boolean {
  return !(
    value instanceof Date ||
    Buffer.isBuffer(value) ||
    value instanceof Map ||
    value instanceof Set ||
    ArrayBuffer.isView(value)
  );
}

export function projectByShape<T>(shape: unknown, value: T): Projection<T> {
  const undeclared: string[] = [];
  const projected = walk(shape, value, '', undeclared, new WeakSet());
  return { value: projected as T, undeclared, shapeMismatch: sharesNoKey(shape, value) };
}

/** True when a non-empty object (or every non-empty element) names no declared key. */
function sharesNoKey(shape: unknown, value: unknown): boolean {
  const declared = declaredPropertiesOf(shape);
  if (!declared || value === null || typeof value !== 'object') return false;
  const candidates: unknown[] = Array.isArray(value) ? (value as unknown[]) : [value];
  const rows = candidates.filter(
    (row): row is Record<string, unknown> =>
      row !== null && typeof row === 'object' && Object.keys(row).length > 0,
  );
  return rows.length > 0 && rows.every((row) => !Object.keys(row).some((key) => declared.has(key)));
}

function walk(
  shape: unknown,
  value: unknown,
  path: string,
  undeclared: string[],
  visiting: WeakSet<object>,
): unknown {
  if (value === null || value === undefined || typeof value !== 'object') return value;

  if (Array.isArray(value)) {
    let changed = false;
    const next = value.map((entry: unknown) => {
      const projected = walk(shape, entry, `${path}[]`, undeclared, visiting);
      if (projected !== entry) changed = true;
      return projected;
    });
    return changed ? next : value;
  }

  const declared = declaredPropertiesOf(shape);
  if (!declared || !isWalkable(value)) return value;
  // A cyclic VALUE cannot be serialised anyway; stop rather than recurse forever.
  if (visiting.has(value)) return value;
  visiting.add(value);

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

  for (const key of Object.keys(row)) {
    const at = path ? `${path}.${key}` : key;
    if (!declared.has(key)) {
      undeclared.push(at);
      replace(key, undefined);
      continue;
    }
    const child = row[key];
    if (child === null || typeof child !== 'object' || isFreeForm(shape, key)) continue;

    const childShape = declaredType(shape, key) ?? propertyType(shape, key);
    if (declaredPropertiesOf(childShape) === undefined) continue;
    const projected = walk(childShape, child, at, undeclared, visiting);
    if (projected !== child) replace(key, projected);
  }

  visiting.delete(value);
  return result;
}
