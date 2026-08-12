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

  /*
   * ── Money ────────────────────────────────────────────────────────────────
   *
   * `withdrawal.*` is back with the money rebuild. `program.create|update`
   * is not — the commission engine returns with the MT5 bridge.
   *
   * These three commit INSIDE the money transaction (R-6.5), not beside it, so
   * a payout that moved without a record of who authorised it is not a state
   * this system can reach.
   *
   * `audit-coverage.spec.ts` reads every `@Audited(...)` string off the route
   * metadata and fails if it is missing from this list — an action with no
   * label here is one an operator cannot filter for, and "no results" reads as
   * "it never happened".
   */
  { action: 'withdrawal.approve', label: 'Withdrawal approved', group: 'Compliance' },
  { action: 'withdrawal.reject', label: 'Withdrawal rejected', group: 'Compliance' },
  /* Settlement is the step that actually releases the money — a separate
     permission from approval (R-5.4), and a separate line here. */
  { action: 'withdrawal.settle', label: 'Withdrawal marked paid', group: 'Compliance' },
  /* Money placed into a wallet BY HAND — the only way funds arrive without a
     payment provider, and so the entry an auditor looks for first. The payload
     carries the reason the operator was required to give. */
  { action: 'wallet.credit', label: 'Wallet credited by hand', group: 'Compliance' },
  { action: 'wallet.create', label: 'Wallet opened', group: 'Compliance' },
  /* Only ever an EMPTY, unused wallet — the service refuses any other. Audited
     BEFORE the delete, so the currency and owner are still readable. */
  { action: 'wallet.delete', label: 'Wallet closed', group: 'Compliance' },

  // ── Trading accounts ──────────────────────────────────────────────────────
  //
  // Three actions rather than one, because they are three different powers and
  // an auditor asks about them separately. Opening an account costs nothing;
  // the other two move money on a server the CRM does not own, with no ledger
  // row anywhere else to reconcile against — this log is the only record.
  { action: 'trading.account_create', label: 'MT5 account opened', group: 'Compliance' },
  { action: 'trading.deposit', label: 'MT5 account credited', group: 'Compliance' },
  { action: 'trading.withdraw', label: 'MT5 account debited', group: 'Compliance' },

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
  /*
   * The three SELF-service actions. Recorded for the same reason the reset pair
   * above is: they are the moves an attacker makes with a session they have
   * just stolen — rotate the password so the owner cannot get back in, then end
   * the owner's sessions — and neither has a fingerprint anywhere else.
   *
   * `admin.session_revoke` is the caller ending one of their OWN sessions.
   * Ending somebody ELSE's is not an operation this system has.
   */
  {
    action: 'admin.password_change',
    label: 'Own password changed',
    group: 'Administrators',
  },
  { action: 'admin.session_revoke', label: 'Own session signed out', group: 'Administrators' },
  { action: 'admin.avatar_change', label: 'Own profile photo changed', group: 'Administrators' },
  /*
   * Distinct from `admin.update` below, which is somebody editing SOMEBODY
   * ELSE. Collapsing the two would make "who renamed this account" unanswerable
   * from the log — and that is the question an auditor asks when an action is
   * attributed to a name nobody recognises.
   */
  { action: 'admin.profile_update', label: 'Own details changed', group: 'Administrators' },
  { action: 'admin.update', label: 'Administrator changed', group: 'Administrators' },
  { action: 'admin.suspend', label: 'Administrator suspended', group: 'Administrators' },
  { action: 'admin.activate', label: 'Administrator reactivated', group: 'Administrators' },
  { action: 'role.create', label: 'Role created', group: 'Administrators' },
  { action: 'role.update', label: 'Role changed', group: 'Administrators' },
  { action: 'role.delete', label: 'Role deleted', group: 'Administrators' },
  /*
   * Issuing a key is granting standing, non-expiring access to the admin API
   * without a login — closer to creating an administrator than to changing a
   * setting, which is why both live in this group.
   */
  { action: 'api_key.create', label: 'API key issued', group: 'Administrators' },
  { action: 'api_key.revoke', label: 'API key revoked', group: 'Administrators' },

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
  /*
   * ── The catalogue: what is sold, and who may sell it ─────────────────────
   *
   * Configuration by category and commercial by consequence. Attaching a group
   * to a product decides what a client's account is actually opened in, and
   * `agency.products_set` decides what every client under every partner on that
   * agency may open — neither leaves a trace on the rows that result, which all
   * look like ordinary accounts. This log is the only record of the decision.
   */
  { action: 'product.create', label: 'Product created', group: 'Configuration' },
  { action: 'product.update', label: 'Product changed', group: 'Configuration' },
  { action: 'product.delete', label: 'Product deleted', group: 'Configuration' },
  {
    action: 'product.group_attach',
    label: 'MT5 group attached to a product',
    group: 'Configuration',
  },
  {
    action: 'product.group_detach',
    label: 'MT5 group detached from a product',
    group: 'Configuration',
  },
  { action: 'agency.create', label: 'Agency created', group: 'Configuration' },
  { action: 'agency.update', label: 'Agency changed', group: 'Configuration' },
  { action: 'agency.delete', label: 'Agency deleted', group: 'Configuration' },
  { action: 'agency.products_set', label: "An agency's products changed", group: 'Configuration' },
  /*
   * Trading terms. Configuration rather than Money for the same reason as the
   * currencies below — no balance moves — but it is the entry an auditor comes
   * looking for after the fact: the leverage ladder, the per-client account
   * caps and the demo funding ceiling are all limits somebody can raise, and
   * the effect shows up in the broker's own reporting weeks later.
   */
  { action: 'settings.trading.update', label: 'Trading terms changed', group: 'Configuration' },
  /*
   * Currencies. Grouped as Configuration rather than Money, deliberately: these
   * change what the platform OFFERS, not what any client holds — no balance
   * moves. What they do change is platform-wide and quiet: disabling a currency
   * stops every new wallet and deposit in it, and moving the default changes
   * what every subsequent registration opens. Both need to be attributable
   * months later, which is exactly what an unlabelled action prevents.
   */
  { action: 'currency.create', label: 'Currency added', group: 'Configuration' },
  { action: 'currency.update', label: 'Currency changed', group: 'Configuration' },
  { action: 'currency.delete', label: 'Currency removed', group: 'Configuration' },
  /*
   * The IB payout ladder. Configuration rather than Money for the same reason
   * currencies are: no balance moves. What DOES move is what every partner
   * earns from that point on, and a level's share changing is the kind of thing
   * somebody asks about a quarter later.
   */
  { action: 'ib_level.create', label: 'IB level added', group: 'Configuration' },
  { action: 'ib_level.update', label: 'IB level changed', group: 'Configuration' },
  { action: 'ib_level.delete', label: 'IB level removed', group: 'Configuration' },
  // Renumbering moves every partner's placement with it, so it is its own act.
  { action: 'ib_level.reorder', label: 'IB ladder reordered', group: 'Configuration' },

  /*
   * A partner DECISION, not a configuration change — hence a different group
   * from the three above. Approving creates somebody who will be paid by the
   * platform, and "who let this partner in, and when" is the first question
   * asked when a payout is disputed.
   */
  { action: 'ib.approve', label: 'Partner application approved', group: 'Compliance' },
  { action: 'ib.reject', label: 'Partner application rejected', group: 'Compliance' },
  /*
   * Changes to a LIVE partner, which is a different question from who was let
   * in. "Who moved this partner to level 2, and when" is asked when a payout
   * looks wrong, and the level is what decides the rate.
   */
  { action: 'ib.level_change', label: 'Partner level changed', group: 'Compliance' },
  { action: 'ib.parent_change', label: 'Partner parent reassigned', group: 'Compliance' },
  /*
   * `ib.partners.suspend`, matching what is actually written.
   *
   * The action was renamed to sit alongside its permission key and this entry
   * kept the old spelling, so the catalog listed a name nothing writes while
   * the name that IS written was listed nowhere. The consequence is the one
   * `audit-coverage.spec.ts` states: partner suspensions were unfilterable on
   * the audit screen, and an operator reads "no results" as "it never
   * happened" — about the record of somebody's earnings being switched off.
   */
  {
    action: 'ib.partners.suspend',
    label: 'Partner suspended or reactivated',
    group: 'Compliance',
  },

  /*
   * Payment methods. A write here changes the account number every client is
   * told to send money to — "who changed the Whish number, and when" is the
   * first question asked when a deposit goes missing.
   */
  { action: 'payment_method.create', label: 'Payment method added', group: 'Configuration' },
  { action: 'payment_method.update', label: 'Payment method changed', group: 'Configuration' },
  { action: 'payment_method.delete', label: 'Payment method removed', group: 'Configuration' },

  // ── Security controls ─────────────────────────────────────────────────────
  { action: 'ip_allowlist.add', label: 'Network rule added', group: 'Security' },
  { action: 'ip_allowlist.remove', label: 'Network rule removed', group: 'Security' },
  { action: 'security.control.set', label: 'Security control toggled', group: 'Security' },
  /*
   * Grouped under Security rather than Configuration, unlike the other settings
   * writes. Repointing SMTP redirects every password-reset and admin-invite link
   * this system sends, so it belongs beside the controls an auditor reviews for
   * takeover attempts rather than beside the brand name.
   */
  { action: 'settings.smtp.update', label: 'Mail server configuration changed', group: 'Security' },

  /*
   * ── Exports ───────────────────────────────────────────────────────────────
   *
   * The one group here that records READS rather than writes, and the exception
   * to the rule stated in `audited.decorator.ts` that a GET is governed by
   * R-6.6 instead.
   *
   * An export is not an ordinary read. Opening the client list shows an
   * administrator a page of twenty-five rows on a screen; exporting it puts
   * every matching row — names, emails, countries, withdrawal amounts,
   * identity-verification decisions — into a file that leaves the building on
   * a laptop. "Which administrator took a copy of the client base, and when" is
   * the first question asked after a leak, and it is precisely the question the
   * audit log exists to be able to answer.
   *
   * The same reasoning already applies to `kyc.document.view` and
   * `kyc.submission.view`, which are also GETs and also recorded. This extends
   * it to the four exports that carry client PII or money, and deliberately no
   * further: the configuration exports (currencies, tags, payment methods,
   * roles, administrators) copy no client data, and recording those would fill
   * the log with rows nobody searches for and make the ones that matter harder
   * to find.
   */
  { action: 'export.clients', label: 'Client list exported', group: 'Exports' },
  { action: 'export.withdrawals', label: 'Withdrawals exported', group: 'Exports' },
  { action: 'export.kyc', label: 'KYC queue exported', group: 'Exports' },
  /*
   * Exporting the trail itself is recorded IN the trail. Not circular — the row
   * lands after the read it describes, so it appears in the next export and not
   * in its own, which is the correct and useful behaviour: a reader of export N
   * can see that export N-1 happened.
   */
  { action: 'export.audit_log', label: 'Admin action log exported', group: 'Exports' },
  { action: 'export.ib_applications', label: 'Partner applications exported', group: 'Exports' },
  { action: 'export.ib_partners', label: 'Partner list exported', group: 'Exports' },
  /*
   * The two holdings exports, recorded for the reason the block above states:
   * they carry client money and client PII off the screen and into a file.
   *
   * `export.wallets` is the strongest case in this group — it is every client's
   * balance, which is the single most sensitive table a CRM export can produce.
   */
  { action: 'export.wallets', label: 'Wallet balances exported', group: 'Exports' },
  {
    action: 'export.trading_accounts',
    label: 'Trading accounts exported',
    group: 'Exports',
  },
] as const;

/** Every action key, for the coverage test and for validating `?action=`. */
export const AUDIT_ACTION_KEYS: ReadonlySet<string> = new Set(
  AUDIT_ACTIONS.map((entry) => entry.action),
);
