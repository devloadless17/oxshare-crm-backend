import { SetMetadata } from '@nestjs/common';

export const AUDIT_KEY = 'audit_stance';

export interface AuditStance {
  stance: 'audited' | 'none';
  /** The `audit_log.action` value, or the reason there is no row. */
  note: string;
}

/**
 * This route writes an `audit_log` row, under `action`.
 *
 * @param action the exact value written, so the declaration can be checked
 *   against the code rather than believed.
 */
export const Audited = (action: string) =>
  SetMetadata<string, AuditStance>(AUDIT_KEY, { stance: 'audited', note: action });

/**
 * This route deliberately writes no audit row, with the reason.
 *
 * @param reason why the action is not worth recording, or is recorded
 *   elsewhere. Long enough to be a sentence — an exemption list that fills up
 *   with "n/a" is an exemption list nobody reviews.
 */
export const NotAudited = (reason: string) =>
  SetMetadata<string, AuditStance>(AUDIT_KEY, { stance: 'none', note: reason });

/*
 * WHY, on a money system.
 *
 * FSD §10 requires "attributable, reviewable records of administrative
 * actions", and DECISIONS D-21 records the reasoning that made the audit log
 * worth building before anything asked for it: it is the ONE thing here that
 * cannot be reconstructed afterwards. History not recorded is lost, and the
 * cost of recording it is a table and a line per action.
 *
 * Coverage was good and INCOMPLETE, in the way coverage always is when it
 * depends on remembering. Rejection reasons — the text a client is told when
 * their withdrawal is refused — could be rewritten with no trace. So could the
 * KYC form definition that governs what every client must submit, and the
 * platform download links the portal serves to clients. None of those look like
 * money, so none of them got a line; all three change what happens to clients'
 * money or identity documents.
 *
 * So the rule is inverted here, the same way `@RequirePermissions` and
 * `@ScopedToClients` invert theirs: every MUTATING admin route must state
 * whether it records, and `test/audit-coverage.spec.ts` fails CI on any that
 * says nothing. Forgetting becomes a red build rather than a silent gap in the
 * one record that cannot be rebuilt.
 *
 * Only mutating routes. A GET that reads client PII is a different rule with a
 * different answer (R-6.6, `kyc.submission.view` and `kyc.document.view`), and
 * requiring an audit row on every read would produce a log nobody can search.
 */
