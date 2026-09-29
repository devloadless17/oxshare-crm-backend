import type {
  AdminPaymentMethod,
  ClientPaymentMethod,
  PaymentMethodRow,
} from './payment-methods.service';
import { askedProofFields } from '../../common/payments/proof-fields';

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

/**
 * The console's shape — `AdminPaymentMethodDto`: the method, the desk's own
 * label for it, and what the desk may do to it.
 */
export function adminPaymentMethodView(row: AdminPaymentMethod) {
  return {
    ...paymentMethodView(row),
    internalLabel: row.internalLabel,
    builtIn: row.builtIn,
    inUse: row.inUse,
    // Every question, hidden ones included — the console edits them all.
    proofFields: row.proofFields.map((field) => ({
      id: field.id,
      label: field.label,
      type: field.type,
      required: field.required,
      enabled: field.enabled,
      hint: field.hint ?? null,
    })),
  };
}

/**
 * What a CLIENT is sent — `PaymentMethodDto`, picked by name.
 *
 * `GET /payments/methods` returned the stored row spread with its bounds, so
 * every column added to the table reached the portal until the response
 * projection stripped it. `internal_label` (0161) is the desk's private name for
 * a method ("BLOM account 1234"), and it must not depend on that backstop.
 */
export function clientPaymentMethodView(row: ClientPaymentMethod) {
  return {
    ...paymentMethodView(row),
    minAmount: row.minAmount,
    maxAmount: row.maxAmount,
    // Only what the client is ASKED: shown fields, and only for an offline method.
    proofFields: askedProofFields(row.proofFields, row.requiresProof),
  };
}
