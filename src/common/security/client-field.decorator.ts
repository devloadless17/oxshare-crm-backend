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
