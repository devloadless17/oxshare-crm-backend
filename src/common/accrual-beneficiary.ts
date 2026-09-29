import { sql, type SQL } from 'drizzle-orm';
import { ibAccruals } from '../database/schema';

/**
 * WHOSE an accrual is, for every territory question — one rule, two forms.
 *
 * A REBATE is paid to the client who traded; a COMMISSION to the partner who
 * introduced them. So "may this admin see this accrual" is asked about the
 * beneficiary, not about whichever of the two ids a query happened to join on.
 * The commission screens scope by it (`IbStore.findAccrualsPage`) and the
 * clawback task names it as its client, so an admin is told to reverse exactly
 * the accruals they can open.
 *
 * The TypeScript and SQL forms sit side by side on purpose: they must say the
 * same thing, and two copies in two files is how they would stop doing so.
 */
export function accrualBeneficiary(accrual: {
  kind: string;
  ibUserId: number;
  clientUserId: number;
}): number {
  return accrual.kind === 'rebate' ? accrual.clientUserId : accrual.ibUserId;
}

/** `accrualBeneficiary`, as a column expression over `ib_accruals`. */
export function accrualBeneficiarySql(): SQL {
  return sql`CASE WHEN ${ibAccruals.kind} = 'rebate'
        THEN ${ibAccruals.clientUserId} ELSE ${ibAccruals.ibUserId} END`;
}
