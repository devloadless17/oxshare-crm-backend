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
    nameAr: row.nameAr ?? null,
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
    // The route it runs on and whether clients see it (0168) — picked by name
    // like everything here, so a field the DTO declares but this omits never
    // reaches the console (it rendered "undefined · undefined" until it was added).
    providerCode: row.providerCode,
    channelCode: row.channelCode,
    availability: row.availability,
    // Who it is offered to (0178). Never in the client's view.
    countryRule: row.countryRule ?? null,
    countryCodes: row.countryCodes,
    // Every question, hidden ones included — the console edits them all.
    proofFields: row.proofFields.map((field) => ({
      id: field.id,
      label: field.label,
      labelAr: field.labelAr ?? null,
      type: field.type,
      required: field.required,
      enabled: field.enabled,
      hint: field.hint ?? null,
      hintAr: field.hintAr ?? null,
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
