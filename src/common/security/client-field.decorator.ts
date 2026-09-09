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

/**
 * Merge a metadata map along the PROTOTYPE CHAIN, child winning.
 *
 * `getOwnMetadata` stops at the class it is asked about, and these DTOs inherit:
 * `IbSubPartnerRowDto extends IbPartnerPersonDto`, whose `email`, `firstName`
 * and `lastName` carry the marks. Read as own-metadata the child declares
 * nothing, so the walker would not mask a sub-partner's address and the census
 * would demand a statement for a field that already has one — a bug in the
 * mechanism, found by the census on the first shape that inherits.
 *
 * `getMetadata` alone is no better: it returns the NEAREST ancestor's map whole,
 * so a child that adds marks of its own would hide the parent's. Merging from
 * the base down, with the child written last, is the only reading that keeps
 * both.
 */
function inherited(key: string, type: unknown): ClientFieldMap {
  if (typeof type !== 'function') return new Map();

  const chain: unknown[] = [];
  for (
    let c: unknown = type;
    typeof c === 'function' && c !== Function.prototype;
    c = Object.getPrototypeOf(c)
  ) {
    chain.unshift(c);
  }

  const merged = new Map<string, string>();
  for (const link of chain) {
    const own = Reflect.getOwnMetadata(key, link as object) as Map<string, string> | undefined;
    if (own) for (const [property, value] of own) merged.set(property, value);
  }
  return merged;
}

/** The marked fields on `type`, including any it inherits. */
export function clientFieldsOf(type: unknown): ClientFieldMap {
  return inherited(CLIENT_FIELD_KEY, type);
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
  return inherited(NOT_CLIENT_FIELD_KEY, type);
}

/** The class-level exemption reason, if `type` carries one. */
export function noClientFieldsReason(type: unknown): string | undefined {
  if (typeof type !== 'function') return undefined;
  return Reflect.getOwnMetadata(NO_CLIENT_FIELDS_KEY, type) as string | undefined;
}

export const CLIENT_FIELD_MAP_KEY = 'rbac03:client_field_map';

/**
 * This property is a FREE-FORM MAP whose keys are catalogue-addressed under a
 * prefix.
 *
 * The case a shape cannot describe, and it is the most sensitive one in the
 * system. `KycSubmissionDto.personalInfo` is `Record<string, string>` because
 * the KYC step builder lets an operator ADD FIELDS — so the shape genuinely is
 * not knowable at compile time, and a fixed DTO would under-declare it by
 * design rather than by mistake.
 *
 * Meanwhile the catalogue masks `kyc.personalInfo.dateOfBirth`,
 * `.nationality`, `.address` and `.phone`. Walking declared properties finds
 * none of them: an untyped map has no declared properties at all. So
 * `applyMask` — which removes by path from the object that exists — was the
 * only thing protecting the single richest concentration of client PII in the
 * product, and masking by shape was blind to all of it.
 *
 * `@ClientFieldMap('kyc.personalInfo')` says: every key inside this object is
 * `kyc.personalInfo.<key>` in the catalogue. The walker then removes the keys
 * the reader may not see, whatever they happen to be called — including custom
 * fields added after this code was written, which is the property a fixed DTO
 * could never have.
 *
 * @param prefix the catalogue prefix the map's own keys hang off.
 */
export const ClientFieldMap =
  (prefix: string): PropertyDecorator =>
  (target, propertyKey) => {
    const owner = target.constructor;
    const existing = (Reflect.getOwnMetadata(CLIENT_FIELD_MAP_KEY, owner) ??
      new Map<string, string>()) as Map<string, string>;
    existing.set(String(propertyKey), prefix);
    Reflect.defineMetadata(CLIENT_FIELD_MAP_KEY, existing, owner);
  };

/** The free-form maps declared on `type`, as `property -> catalogue prefix`. */
export function clientFieldMapsOf(type: unknown): ClientFieldMap {
  return inherited(CLIENT_FIELD_MAP_KEY, type);
}
