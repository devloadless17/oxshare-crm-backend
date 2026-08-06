/**
 * Every action the admin action log can record, with a human label.
 *
 * ── Why this exists ─────────────────────────────────────────────────────────
 *
 * The audit screen's action filter was a hardcoded list of EIGHT, written when
 * eight was all there was. The system now records thirty-four. Everything
 * missing was unfilterable — including every one of the actions added because
 * they were previously unrecorded, which is to say the ones somebody would go
 * looking for: who rewrote the rejection reason a client was emailed, who
 * disabled a KYC step, who repointed a download link.
 *
 * A filter that silently offers a subset is the same class of defect as a
 * silently ignored query parameter (R-2.5): the operator reads "no results for
 * Rejection Reason Update" as "that never happened", when the truth is that
 * they could not ask.
 *
 * ── Why a catalog rather than DISTINCT over the table ───────────────────────
 *
 * `SELECT DISTINCT action FROM audit_log` would only ever offer what has
 * ALREADY happened, so a filter for an action nobody has performed yet does not
 * exist — and "has anyone ever done X" is exactly the question an auditor
 * arrives with. It is also a scan of an append-only table that only grows.
 *
 * This is the same shape as `permissions.json` and `client-fields.json`, for
 * the same reason (R-4.5): the frontend never invents a key, and the vocabulary
 * has one definition on the server.
 *
 * ── What stops it going stale ───────────────────────────────────────────────
 *
 * `test/audit-coverage.spec.ts` reads every `@Audited('…')` declaration off the
 * route metadata and fails if any of them is missing here. Adding an audited
 * action without labelling it is a red build, not a filter that quietly forgets
 * the newest thing anybody would search for.
 */
export interface AuditActionDefinition {
  action: string;
  label: string;
  /** Groups the filter, so thirty-four entries are readable. */
  group: string;
}

export const AUDIT_ACTIONS: readonly AuditActionDefinition[] = [
  // ── Clients ───────────────────────────────────────────────────────────────
  { action: 'client.suspend', label: 'Client suspended', group: 'Clients' },
  { action: 'client.activate', label: 'Client reactivated', group: 'Clients' },
  { action: 'client_tag.assign', label: 'Tag added to client', group: 'Clients' },
  { action: 'client_tag.unassign', label: 'Tag removed from client', group: 'Clients' },

  // ── Verification ──────────────────────────────────────────────────────────
  { action: 'kyc.approve', label: 'KYC approved', group: 'Verification' },
  { action: 'kyc.reject', label: 'KYC rejected', group: 'Verification' },
  { action: 'kyc.claim', label: 'KYC claimed for review', group: 'Verification' },
  { action: 'kyc.submission.view', label: 'KYC submission opened', group: 'Verification' },
  { action: 'kyc.document.view', label: 'KYC document viewed', group: 'Verification' },

  // ── Money ─────────────────────────────────────────────────────────────────
  { action: 'withdrawal.approve', label: 'Withdrawal approved', group: 'Money' },
  { action: 'withdrawal.reject', label: 'Withdrawal rejected', group: 'Money' },
  { action: 'withdrawal.settle', label: 'Withdrawal paid', group: 'Money' },
  { action: 'program.create', label: 'Commission plan created', group: 'Money' },
  { action: 'program.update', label: 'Commission plan changed', group: 'Money' },

  // ── Administrators ────────────────────────────────────────────────────────
  { action: 'admin.invite', label: 'Administrator invited', group: 'Administrators' },
  {
    action: 'admin.invite_accept',
    label: 'Administrator account created',
    group: 'Administrators',
  },
  { action: 'admin.invite_revoke', label: 'Invite revoked', group: 'Administrators' },
  /*
   * Both halves of a password reset are listed, and both are filterable.
   *
   * D-44 accepts that a master admin can reset another master — which means one
   * administrator can take another's account — ONLY because this trail exists.
   * "Who reset whose password, and when" is the first question an auditor asks
   * after an account does something its owner denies, and an action missing
   * from this catalogue reads as "it never happened" on the audit screen.
   */
  {
    action: 'admin.password_reset_initiate',
    label: 'Password reset sent',
    group: 'Administrators',
  },
  {
    action: 'admin.password_reset_complete',
    label: 'Password reset completed',
    group: 'Administrators',
  },
  { action: 'admin.update', label: 'Administrator changed', group: 'Administrators' },
  { action: 'admin.suspend', label: 'Administrator suspended', group: 'Administrators' },
  { action: 'admin.activate', label: 'Administrator reactivated', group: 'Administrators' },
  { action: 'role.create', label: 'Role created', group: 'Administrators' },
  { action: 'role.update', label: 'Role changed', group: 'Administrators' },
  { action: 'role.delete', label: 'Role deleted', group: 'Administrators' },

  // ── Configuration ─────────────────────────────────────────────────────────
  //
  // The group that was entirely unrecorded until this work, and the reason the
  // hardcoded filter was worth replacing rather than extending: none of these
  // looks like money, and every one of them changes what happens to a client's
  // money or identity documents.
  { action: 'client_tag.create', label: 'Client tag created', group: 'Configuration' },
  { action: 'client_tag.update', label: 'Client tag renamed', group: 'Configuration' },
  { action: 'client_tag.delete', label: 'Client tag deleted', group: 'Configuration' },
  { action: 'rejection_reason.create', label: 'Rejection reason added', group: 'Configuration' },
  { action: 'rejection_reason.update', label: 'Rejection reason reworded', group: 'Configuration' },
  { action: 'rejection_reason.delete', label: 'Rejection reason removed', group: 'Configuration' },
  { action: 'kyc_config.replace', label: 'KYC form replaced', group: 'Configuration' },
  { action: 'kyc_config.reset', label: 'KYC form reset to defaults', group: 'Configuration' },
  { action: 'kyc_config.step_add', label: 'KYC step added', group: 'Configuration' },
  { action: 'kyc_config.step_update', label: 'KYC step changed', group: 'Configuration' },
  { action: 'kyc_config.step_delete', label: 'KYC step deleted', group: 'Configuration' },
  { action: 'platform_link.set', label: 'Download link changed', group: 'Configuration' },

  // ── Security controls ─────────────────────────────────────────────────────
  { action: 'ip_allowlist.add', label: 'Network rule added', group: 'Security' },
  { action: 'ip_allowlist.remove', label: 'Network rule removed', group: 'Security' },
  { action: 'security.control.set', label: 'Security control toggled', group: 'Security' },
] as const;

/** Every action key, for the coverage test and for validating `?action=`. */
export const AUDIT_ACTION_KEYS: ReadonlySet<string> = new Set(
  AUDIT_ACTIONS.map((entry) => entry.action),
);
