import 'reflect-metadata';

/**
 * RBAC-03, declared ON THE SHAPE instead of on every surface that returns it.
 *
 * ## The problem this exists to remove
 *
 * Masking today is declared twice for every screen. `client-fields.json` maps a
 * catalogue key to one alias PER SURFACE — `withdrawal.user.email`,
 * `withdrawalExport.userEmail`, `wallet.user.email`, `ibPartner.parent.email` —
 * and then a service has to remember to call `applyMask` on that surface. Both
 * halves are opt-in, and unmasked is what you get if either is missed.
 *
 * That has now failed eight times, and the growth is the reason: 10 maskable
 * fields across 11 surfaces is 46 alias entries and 27 hand-written call sites,
 * five of those surfaces added in a single day while closing the last three
 * exposures. Every new screen is two more chances to forget.
 *
 * The observation this is built on: the surfaces are not actually distinct.
 * `HoldingOwnerDto` is the person on the wallet desk AND on the trading-account
 * desk. `WithdrawalUserDto` is the person on the withdrawals list, on its CSV,
 * and on all four transition responses. The alias sprawl is describing one
 * shape reached by many routes as though it were many shapes.
 *
 * So mark the FIELD, once, where it is defined:
 *
 *     export class HoldingOwnerDto {
 *       @ApiProperty() id: string;
 *       @ClientField('client.email') email: string;
 *     }
 *
 * Every response that embeds that DTO inherits the mask, including responses
 * nobody has written yet. That is the property the alias list cannot have.
 *
 * ## What this does NOT change
 *
 * The catalogue stays. `client-fields.json` remains the list of what an operator
 * may CHOOSE to hide, which is a product decision and is served to the console
 * so the role editor can offer it. What moves is the mapping from that choice to
 * the places the value appears — out of a hand-maintained alias list and onto
 * the shapes themselves.
 */
export const CLIENT_FIELD_KEY = 'rbac03:client_field';

/** Marked properties on one class, as `property name -> catalogue key`. */
export type ClientFieldMap = ReadonlyMap<string, string>;

/**
 * Mark a response field as carrying client-owned data.
 *
 * @param catalogueKey the `client-fields.json` key an operator ticks to hide
 *   this — `client.email`, `client.phone`. NOT a path: the path is wherever this
 *   DTO happens to be embedded, which is the entire point.
 */
export function ClientField(catalogueKey: string): PropertyDecorator {
  return (target, propertyKey) => {
    const owner = target.constructor;
    const existing = (Reflect.getOwnMetadata(CLIENT_FIELD_KEY, owner) ??
      new Map<string, string>()) as Map<string, string>;
    existing.set(String(propertyKey), catalogueKey);
    Reflect.defineMetadata(CLIENT_FIELD_KEY, existing, owner);
  };
}

/** The marked fields declared directly on `type`, or an empty map. */
export function clientFieldsOf(type: unknown): ClientFieldMap {
  if (typeof type !== 'function') return new Map();
  return (Reflect.getOwnMetadata(CLIENT_FIELD_KEY, type) ?? new Map()) as ClientFieldMap;
}

export const NOT_CLIENT_FIELD_KEY = 'rbac03:not_client_field';
export const NO_CLIENT_FIELDS_KEY = 'rbac03:no_client_fields';

/**
 * This field carries NO client-owned data, stated with the reason.
 *
 * The half that makes the marking non-optional. `@ClientField` alone is opt-in
 * one level down from `applyMask` — nothing fails when a client-shaped field
 * ships unannotated, which is the property that has failed nine times.
 *
 * And it cannot be inferred. `credentialsSentTo: string` is indistinguishable
 * from `reference: string` until somebody says which it is — that was the ninth
 * exposure, and no heuristic over field names would have caught it. "Whose data
 * is this?" is genuinely not derivable from the shape, which is exactly why
 * stating it adds something, where a route-level masking stance only restated
 * what the DTO already said.
 *
 * @param reason whose data it is instead — the operator's own, a configuration
 *   value, a system identifier. Long enough to be a sentence.
 */
export const NotClientField =
  (reason: string): PropertyDecorator =>
  (target, propertyKey) => {
    const owner = target.constructor;
    const existing = (Reflect.getOwnMetadata(NOT_CLIENT_FIELD_KEY, owner) ??
      new Map<string, string>()) as Map<string, string>;
    existing.set(String(propertyKey), reason);
    Reflect.defineMetadata(NOT_CLIENT_FIELD_KEY, existing, owner);
  };

/**
 * This whole DTO describes no person — a class-level exemption.
 *
 * 102 of the 119 shapes reachable from an admin response carry no person-ish
 * field at all: currencies, roles, permissions, products, levels, settings. One
 * sentence on the class is the honest cost for those, rather than a stance on
 * each of their several hundred fields, which would rot exactly as a
 * route-level register would.
 *
 * ⚠️ It is true of the class AS WRITTEN, and that is the one thing here that
 * can decay: somebody appends `email` to an exempt configuration shape and the
 * declaration is quietly false. Two guards in
 * `test/client-field-coverage.spec.ts` hold it — an exempt class may not
 * reference a class carrying marked fields, and may not carry a person-ish
 * field name. The second reuses the very heuristic that was too weak to be a
 * boundary: as a boundary a false negative leaves a surface ungoverned, but as
 * a guard on an exemption it merely leaves one class wrongly exempt, which is
 * no worse than not checking. Same names, opposite consequence.
 */
export const NoClientFields =
  (reason: string): ClassDecorator =>
  (target) => {
    Reflect.defineMetadata(NO_CLIENT_FIELDS_KEY, reason, target);
  };

/** The fields declared NOT client-owned on `type`, as `property -> reason`. */
export function notClientFieldsOf(type: unknown): ClientFieldMap {
  if (typeof type !== 'function') return new Map();
  return (Reflect.getOwnMetadata(NOT_CLIENT_FIELD_KEY, type) ?? new Map()) as ClientFieldMap;
}

/** The class-level exemption reason, if `type` carries one. */
export function noClientFieldsReason(type: unknown): string | undefined {
  if (typeof type !== 'function') return undefined;
  return Reflect.getOwnMetadata(NO_CLIENT_FIELDS_KEY, type) as string | undefined;
}
