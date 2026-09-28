import type { PaymentMethodRow } from './payment-methods.service';

/**
 * A deposit method as the console reads it — exactly the fields
 * `PaymentMethodDto` declares.
 *
 * The admin list, create and update answered with the stored row, which also
 * carries `updated_by` (an administrator's id) and two timestamps nobody
 * declared — until the response projection's census (28 Sep 2026). Picked BY
 * NAME, so a column added later reaches no response until it is declared.
 */
export function paymentMethodView(row: PaymentMethodRow) {
  return {
    key: row.key,
    name: row.name,
    currency: row.currency,
    logoUrl: row.logoUrl,
    enabled: row.enabled,
    sortOrder: row.sortOrder,
    requiresProof: row.requiresProof,
  };
}
