import type { ibAccounts, ibApplications } from '../../database/schema';

type IbAccountRow = typeof ibAccounts.$inferSelect;
type IbApplicationRow = typeof ibApplications.$inferSelect;

/**
 * A partner account as it crosses the wire — exactly what `IbAccountDto`
 * declares.
 *
 * Some routes answer with an ENRICHED account (its agency's name and products
 * joined in) and some with the stored row, which also carries `agency_id`,
 * `program_id`, `application_id` and two timestamps nobody declared. The
 * approve, level, parent and active routes shipped those until the response
 * projection's census (28 Sep 2026). Picked BY NAME; the joined display fields
 * travel when the caller joined them, and are absent otherwise — as declared.
 */
export function ibAccountView(
  row: Pick<
    IbAccountRow,
    'userId' | 'level' | 'parentIbUserId' | 'referralCode' | 'active' | 'approvedAt'
  > & {
    agencyName?: string | null;
    agencyNameAr?: string | null;
    products?: unknown;
    productsAr?: unknown;
  },
) {
  return {
    userId: row.userId,
    level: row.level,
    parentIbUserId: row.parentIbUserId,
    referralCode: row.referralCode,
    active: row.active,
    approvedAt: row.approvedAt,
    ...(row.agencyName !== undefined ? { agencyName: row.agencyName } : {}),
    ...(row.agencyNameAr !== undefined ? { agencyNameAr: row.agencyNameAr } : {}),
    ...(row.products !== undefined ? { products: row.products } : {}),
    ...(row.productsAr !== undefined ? { productsAr: row.productsAr } : {}),
  };
}

/** A partner application as it crosses the wire — exactly what `IbApplicationDto` declares. */
export function ibApplicationView(
  row: Pick<
    IbApplicationRow,
    | 'id'
    | 'userId'
    | 'motivation'
    | 'website'
    | 'status'
    | 'rejectionReason'
    | 'reviewedBy'
    | 'reviewedAt'
    | 'submittedAt'
  > & {
    agencyName?: string | null;
    agencyNameAr?: string | null;
    /** The reason's Arabic as written with it (0179). */
    rejectionReasonAr?: string | null;
  },
) {
  return {
    id: row.id,
    userId: row.userId,
    motivation: row.motivation,
    website: row.website,
    status: row.status,
    rejectionReason: row.rejectionReason,
    ...(row.rejectionReasonAr ? { rejectionReasonAr: row.rejectionReasonAr } : {}),
    reviewedBy: row.reviewedBy,
    reviewedAt: row.reviewedAt,
    submittedAt: row.submittedAt,
    ...(row.agencyName !== undefined ? { agencyName: row.agencyName } : {}),
    ...(row.agencyNameAr !== undefined ? { agencyNameAr: row.agencyNameAr } : {}),
  };
}
