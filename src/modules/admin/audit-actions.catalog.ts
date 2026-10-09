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
  /**
   * No current code writes this action; rows carrying it are HISTORICAL.
   *
   * Kept in the catalogue rather than deleted, for the reason this file's header
   * gives: the filter exists so an auditor can ask "has anyone ever done X", and
   * a label removed when the feature was is a question they can no longer ask
   * about the rows that already exist. `ib_program.*` were written on every
   * programme edit until migration 0112 retired the catalogue they described.
   *
   * It is also what lets `audit-record-coverage.spec.ts` check the direction it
   * never checked — catalogued-but-never-written — without that check failing on
   * every label a retired feature left behind.
   */
  historical?: true;
}

export const AUDIT_ACTIONS: readonly AuditActionDefinition[] = [
  // ── Clients ───────────────────────────────────────────────────────────────
  /*
   * A profile edit and an EMAIL change are separate actions, for the same
   * reason they are separate permissions: one is a corrected surname, the other
   * is the address the account signs in with. An investigator scanning for "who
   * could have taken this account over" must be able to filter to the second
   * without reading every clerical correction.
   */
  { action: 'client.profile_update', label: 'Client profile edited', group: 'Clients' },
  /*
   * One row per client, written ONCE by migration 0139 when each client's two
   * copies of their identity became one profile: what changed, and any KYC
   * answer that was not taken because the desk had corrected the profile since.
   */
  {
    action: 'client.profile_consolidated',
    label: 'Client profile consolidated (one-time merge)',
    group: 'Clients',
    // Written ONCE, by migration 0139's SQL, which no TypeScript scan can see —
    // the rows exist from the day it runs, and no code writes another.
    historical: true,
  },
  { action: 'client.email_change', label: 'Client sign-in email changed', group: 'Clients' },
  /*
   * The staff's Follow-up and Result notes on a client (0212), before and after.
   * These rows ARE the notes' history: the client page's "History" link opens
   * the log filtered to this action and client.
   */
  { action: 'client.followup_update', label: 'Client follow-up edited', group: 'Clients' },
  /*
   * A reader whose role hides client emails found a client by a COMPLETE
   * address (D-82). The subject is the client found; the typed text is never
   * stored. See `HiddenEmailLookupInterceptor`.
   */
  {
    action: 'client.lookup_hidden_email',
    label: 'Client found by a hidden email address',
    group: 'Clients',
  },
  { action: 'client.suspend', label: 'Client suspended', group: 'Clients' },
  {
    action: 'client.referrer_set',
    label: 'Referring partner recorded',
    group: 'Clients',
  },
  { action: 'client.activate', label: 'Client reactivated', group: 'Clients' },
  { action: 'client_tag.assign', label: 'Tag added to client', group: 'Clients' },
  {
    action: 'client.acquired',
    label: 'Client signed up through a link or a partner',
    group: 'Clients',
  },
  { action: 'client_tag.unassign', label: 'Tag removed from client', group: 'Clients' },
  { action: 'client_tag.bulk', label: 'Tags changed on many clients at once', group: 'Clients' },
  // "New client" (0211): staff create a client for somebody who cannot sign up themselves.
  { action: 'client.created', label: 'Client created by staff', group: 'Clients' },
  { action: 'client.welcome_resend', label: 'Welcome email sent again', group: 'Clients' },

  // ── Verification ──────────────────────────────────────────────────────────
  { action: 'kyc.approve', label: 'KYC approved', group: 'Verification' },
  { action: 'kyc.reject', label: 'KYC rejected', group: 'Verification' },
  { action: 'kyc.claim', label: 'KYC claimed for review', group: 'Verification' },
  { action: 'kyc.release', label: 'KYC handed back to the queue', group: 'Verification' },
  { action: 'kyc.submission.view', label: 'KYC submission opened', group: 'Verification' },
  { action: 'kyc.document.view', label: 'KYC document viewed', group: 'Verification' },
  /*
   * The HISTORY panel, recorded separately from the live submission.
   *
   * Previously decided attempts carry the same `personalInfo` the detail screen
   * shows — email, phone, date of birth, nationality, address — so reading them
   * is the same R-6.6 disclosure by a different URL. The route's own comment
   * says as much about ACCESS ("this is the same PII one decision older, so
   * gating it differently would be arbitrary") and it was gated identically and
   * audited differently.
   *
   * Its own action rather than reusing `kyc.submission.view`, because the two
   * answer different questions for an auditor: who opened the current record,
   * and who went looking through the superseded ones.
   */
  { action: 'kyc.history.view', label: 'KYC history opened', group: 'Verification' },
  /*
   * CORE-18. Its own action rather than folding into `kyc.approve`, because it
   * is the one write that CHANGES WHAT THE CLIENT CLAIMED rather than deciding
   * on it — and its row carries the value on BOTH sides, which is the whole
   * reason somebody comes looking for it later.
   */
  {
    action: 'kyc.identity_correct',
    label: 'KYC identity details corrected',
    group: 'Verification',
  },
  {
    // An APPROVED verification returned to the client to update — the level
    // goes back to 0 with it, so it is a money-gate event as well as a review one.
    action: 'kyc.reverification_request',
    label: 'KYC re-verification requested',
    group: 'Verification',
  },
  /*
   * "Complete KYC" (0210): staff doing a client's KYC FOR them, through the
   * client's own actions. Each its own action, so "what did staff do on this
   * client's verification" is one filter.
   */
  { action: 'kyc.assist_step', label: 'KYC answers saved for a client', group: 'Verification' },
  {
    action: 'kyc.assist_upload',
    label: 'KYC document uploaded for a client',
    group: 'Verification',
  },
  { action: 'kyc.assist_submit', label: 'KYC submitted for a client', group: 'Verification' },
  {
    action: 'kyc.assist_return',
    label: 'KYC returned to complete it for the client',
    group: 'Verification',
  },

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
  /*
   * OFFLINE DEPOSITS — money the client paid outside the platform, credited by
   * a person who looked at a receipt. `deposit.approve` is the row that answers
   * "who put this money in the client's wallet, and on what evidence"; the
   * receipt itself is `deposit.proof.view`, which is a PII read (a bank account,
   * a name, an amount) and is audited for the same reason a KYC document read is.
   */
  { action: 'deposit.approve', label: 'Deposit approved & wallet credited', group: 'Compliance' },
  { action: 'deposit.reject', label: 'Deposit rejected', group: 'Compliance' },
  { action: 'deposit.proof.view', label: 'Deposit receipt opened', group: 'Compliance' },
  /*
   * GATEWAY DEPOSITS — money that arrived without anybody approving it.
   *
   * Written by `settleGatewayDeposit` as SYSTEM_ACTOR, not by a desk. It is
   * in this catalog for the same reason the rows above are: the trail's filter
   * is built from these entries, so an action absent here is one an operator
   * cannot search for even once it is being written.
   */
  {
    action: 'deposit.settle',
    label: 'Deposit settled by the payment provider',
    group: 'Compliance',
  },
  { action: 'withdrawal.approve', label: 'Withdrawal approved', group: 'Compliance' },
  { action: 'withdrawal.reject', label: 'Withdrawal rejected', group: 'Compliance' },
  /* Settlement is the step that actually releases the money — a separate
     permission from approval (R-5.4), and a separate line here. */
  { action: 'withdrawal.settle', label: 'Withdrawal marked paid', group: 'Compliance' },
  /* A transfer the MT5 bridge left in flight, released by hand. It states that
     a movement did NOT happen on evidence outside this system — somebody read
     the broker's deal history — so the payload's reason is the only record of
     why, and the entry an auditor looks for if a client is ever credited
     twice. */
  { action: 'transfer.abandon', label: 'Stuck transfer released', group: 'Compliance' },
  /* A deposit or payout only a person could settle — an amount mismatch, a
     reversal, the platform and the CRM disagreeing — reconciled by hand. Like
     the release above, it records a judgement made on evidence outside this
     system, so the operator's note is the record. */
  {
    action: 'transaction.attention_resolve',
    label: 'Payment anomaly resolved',
    group: 'Compliance',
  },
  /* Money placed into a wallet BY HAND — the only way funds arrive without a
     payment provider, and so the entry an auditor looks for first. The payload
     carries the reason the operator was required to give. */
  { action: 'wallet.credit', label: 'Wallet credited by hand', group: 'Compliance' },
  { action: 'wallet.debit', label: 'Wallet withdrawn from by hand', group: 'Compliance' },
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
  { action: 'trading.account_link', label: 'Existing MT5 account linked', group: 'Compliance' },
  { action: 'trading.account_product', label: 'Trading account product set', group: 'Compliance' },
  { action: 'trading.accounts_sync', label: 'MT5 accounts synced', group: 'Compliance' },
  {
    action: 'settings.jobs.update',
    label: 'Scheduled job interval changed',
    group: 'Configuration',
  },
  { action: 'settings.jobs.run', label: 'Scheduled job run on demand', group: 'Configuration' },
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
   * Accepting an invite on a browser that already held a DIFFERENT admin's
   * session ends that session. The row belongs to the displaced admin — it is
   * their session that ended, and on a shared machine this is the line that
   * explains a sign-out nobody clicked.
   */
  {
    action: 'admin.session_displaced',
    label: 'Session ended by an invite acceptance',
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
  /*
   * The authenticator app (0191) — required at every admin sign-in. Enrolment
   * is recorded with the admin as the actor; a reset by the admin holding
   * `admins.reset` who did it, the target the subject.
   */
  { action: 'admin.totp_enroll', label: 'Authenticator app set up', group: 'Administrators' },
  { action: 'admin.totp_reset', label: 'Authenticator app reset', group: 'Administrators' },
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
  { action: 'admin.signup_link_change', label: 'Sign-up link renamed', group: 'Configuration' },
  { action: 'rejection_reason.create', label: 'Rejection reason added', group: 'Configuration' },
  { action: 'rejection_reason.update', label: 'Rejection reason reworded', group: 'Configuration' },
  { action: 'rejection_reason.delete', label: 'Rejection reason removed', group: 'Configuration' },
  { action: 'kyc_config.replace', label: 'KYC form replaced', group: 'Configuration' },
  // 0178: the countries sign-up, KYC and payment rules offer.
  { action: 'kyc.countries_update', label: 'Countries offered changed', group: 'Configuration' },
  { action: 'kyc_config.reset', label: 'KYC form reset to defaults', group: 'Configuration' },
  { action: 'kyc_config.step_add', label: 'KYC step added', group: 'Configuration' },
  { action: 'kyc_config.step_update', label: 'KYC step changed', group: 'Configuration' },
  { action: 'kyc_config.step_delete', label: 'KYC step deleted', group: 'Configuration' },
  {
    action: 'kyc_config.consolidated',
    label: 'KYC form repaired to the identity core (one-time)',
    group: 'Configuration',
    // Written ONCE, by migration 0147's SQL, which no TypeScript scan can see —
    // the row exists from the day it runs, and no code writes another.
    historical: true,
  },
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
  {
    action: 'product.group_update',
    label: "A product group's minimum deposit changed",
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
   * The portal assistant's switch and daily limits (0187). Turning it on starts
   * spending on the model; turning it off hides it from every client at once.
   */
  {
    action: 'settings.assistant.update',
    label: 'Portal assistant settings changed',
    group: 'Configuration',
  },
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
   * The leverage ladder — Configuration for the same reason currencies are: no
   * balance moves. What changes is the RISK a client may take on, which is a
   * regulatory answer somebody may have to give months later. "Who withdrew
   * 1:500, and when" is the question this makes answerable; before migration
   * 0067 it was one field on a settings row and the audit said only that the
   * trading settings had changed.
   */
  { action: 'leverage.create', label: 'Leverage added', group: 'Configuration' },
  { action: 'leverage.update', label: 'Leverage changed', group: 'Configuration' },
  { action: 'leverage.delete', label: 'Leverage removed', group: 'Configuration' },
  /*
   * The sidebar links every client is shown. Recorded for the reason
   * `platform_link.set` is, one entry above the same class of risk: an admin
   * repointing one of these sends every client who clicks it to whatever is now
   * at the address, and a log line is not a record — it rotates, an operator
   * cannot query it, and it does not appear on the screen somebody investigating
   * would open. The update entry keeps the BEFORE, because the current value
   * answers nothing about a link that was wrong for six hours last Tuesday.
   */
  { action: 'external_link.create', label: 'External link added', group: 'Configuration' },
  { action: 'external_link.update', label: 'External link changed', group: 'Configuration' },
  { action: 'external_link.delete', label: 'External link removed', group: 'Configuration' },
  /*
   * The IB payout ladder. Configuration rather than Money for the same reason
   * currencies are: no balance moves. What DOES move is what every partner
   * earns from that point on, and a level's share changing is the kind of thing
   * somebody asks about a quarter later.
   */
  { action: 'ib_level.create', label: 'IB level added', group: 'Configuration' },
  { action: 'ib_level.update', label: 'IB level changed', group: 'Configuration' },
  { action: 'ib_level.delete', label: 'IB level removed', group: 'Configuration' },
  /*
   * The rate cards products are sold on (0140). Beside the ladder, because the
   * two decide a payout together: the type says what a lot is worth, the level
   * says what share of it a partner takes.
   */
  { action: 'ib_commission_type.create', label: 'Commission type added', group: 'Configuration' },
  {
    action: 'ib_commission_type.update',
    label: 'Commission type changed',
    group: 'Configuration',
  },
  {
    action: 'ib_commission_type.delete',
    label: 'Commission type removed',
    group: 'Configuration',
  },
  // Renumbering moves every partner's placement with it, so it is its own act.
  {
    action: 'ib_level.reorder',
    label: 'IB ladder reordered',
    group: 'Configuration',
    historical: true,
  },

  /*
   * The PROGRAMME is where a partner's rates actually live — the ladder above
   * only decides placement. So these are the entries somebody reads a quarter
   * later asking why a partner's earnings changed, and the update record keeps
   * both the before and the after for exactly that conversation.
   */
  {
    action: 'ib_program.create',
    label: 'Commission programme added',
    group: 'Configuration',
    historical: true,
  },
  {
    action: 'ib_program.update',
    label: 'Commission programme changed',
    group: 'Configuration',
    historical: true,
  },
  {
    action: 'ib_program.delete',
    label: 'Commission programme removed',
    group: 'Configuration',
    historical: true,
  },

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
  // 0197 — a sub-partner's own commission / rebate shares, before and after.
  { action: 'ib.terms_change', label: 'Sub-partner commission changed', group: 'Compliance' },
  {
    action: 'ib.program_change',
    label: 'Partner moved to another commission programme',
    group: 'Partners',

    historical: true,
  },
  { action: 'ib.parent_change', label: 'Partner parent reassigned', group: 'Compliance' },
  /*
   * `Money` rather than `Partners`: this is the only IB action that can DEBIT a
   * wallet. Somebody auditing where a partner's balance went filters by money,
   * and a reversal filed under partner administration is one they would not
   * find — which is the same "no results reads as it never happened" failure
   * this catalog exists to prevent.
   */
  {
    action: 'ib.accrual_reverse',
    label: 'Commission accrual reversed',
    group: 'Money',
  },
  /*
   * The other answer to a clawback task: the partner KEEPS the commission. Filed
   * under Money beside the reversal, because whoever audits a clawback looks for
   * both outcomes in one place.
   */
  {
    action: 'notification.task_close',
    label: 'Task closed without action (e.g. commission kept)',
    group: 'Money',
  },
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
  // Only a method no transaction references (a typo, a test row); a used one is disabled.
  { action: 'payment_method.delete', label: 'Payment method deleted', group: 'Configuration' },
  /*
   * The payout side's twin. Its own actions rather than `payment_method.*`: a
   * deposit rail and a withdrawal rail are separate rows switched separately,
   * and "who stopped Whish payouts" must not be answered by a deposit change.
   */
  {
    action: 'withdrawal_method.create',
    label: 'Withdrawal method added',
    group: 'Configuration',
  },
  {
    action: 'withdrawal_method.update',
    label: 'Withdrawal method changed',
    group: 'Configuration',
  },
  {
    action: 'withdrawal_method.delete',
    label: 'Withdrawal method deleted',
    group: 'Configuration',
  },

  // ── Security controls ─────────────────────────────────────────────────────
  /*
   * `security.control.set` is GONE, same rule: `SecuritySettingsStore` has no
   * consumer at all — its own header says "DEAD UNTIL A SWITCH HAS A READER" —
   * so no toggle exists to record. Restore this entry in the same commit that
   * gives a control a reader, not before.
   */
  /*
   * RBAC-08. Both sides are logged because both change who can reach the
   * console: adding a rule starts enforcement (or narrows it), and removing the
   * last one stops it entirely. "Who opened the console to the internet, and
   * when" has to be answerable from the audit screen rather than the table.
   */
  /*
   * A REFUSAL, recorded. Permission denials were `logger.warn` only, so "who
   * keeps trying to reach the payout queue without the key" had no answer on
   * the audit screen — the one place an investigator looks. Written by
   * `PermissionsGuard` with the route and the keys it demanded.
   */
  { action: 'security.denied', label: 'Action refused (permission)', group: 'Security' },
  { action: 'ip_allowlist.add', label: 'Network rule added', group: 'Security' },
  { action: 'ip_allowlist.remove', label: 'Network rule removed', group: 'Security' },
  // 0192: an administrator allowed to reach the console from ANY network.
  {
    action: 'ip_allowlist.exempt_add',
    label: 'Admin allowed from any network',
    group: 'Security',
  },
  {
    action: 'ip_allowlist.exempt_remove',
    label: 'Admin any-network access removed',
    group: 'Security',
  },
  /*
   * Grouped under Security rather than Configuration, unlike the other settings
   * writes. Repointing SMTP redirects every password-reset and admin-invite link
   * this system sends, so it belongs beside the controls an auditor reviews for
   * takeover attempts rather than beside the brand name.
   */
  { action: 'settings.smtp.update', label: 'Mail server configuration changed', group: 'Security' },

  /*
   * The Rival connection — same Security grouping as SMTP, sharper reason:
   * the API key can create payouts against the company's Rival balance, and
   * repointing the base URL redirects every payout instruction this system
   * issues. The webhook-key rotation is the row an auditor wants when the
   * money-event stream went quiet ("did the signing key change that day").
   */
  // Written until 0177, when the Rival tab's routes went; kept so past rows stay findable.
  {
    action: 'settings.rival.update',
    label: 'Payments-platform (Rival) connection changed',
    group: 'Security',
    historical: true,
  },
  {
    action: 'settings.rival.webhook_key.rotate',
    label: 'Payments-platform (Rival) webhook key generated',
    group: 'Security',
    historical: true,
  },
  /*
   * Payment providers (0168) — the Rival rows' stakes, for every provider: a
   * base URL receives every payment and payout instruction, a secret can move
   * money. Switching one on or off is its own action, because "who switched
   * Rival off" is the question asked the moment deposits stop.
   */
  { action: 'payment_provider.update', label: 'Payment provider changed', group: 'Security' },
  { action: 'payment_provider.enable', label: 'Payment provider switched on', group: 'Security' },
  {
    action: 'payment_provider.disable',
    label: 'Payment provider switched off',
    group: 'Security',
  },
  {
    action: 'payment_provider.secret_rotate',
    label: 'Payment provider secret generated',
    group: 'Security',
  },

  /*
   * The Rival withdrawal choreography. `withdrawal.rival.submit` is the row an
   * auditor follows from a CRM approval to the payout request at Rival (it
   * carries the Rival id — or the refusal); `withdrawal.rival.reject` is
   * Rival's refusal landing back as a refund; `withdrawal.cancel` is the
   * operator pulling an approved payout back before Rival pays it. All three
   * are the money-out trail between the two systems, beside the existing
   * approve/reject/settle rows.
   */
  /*
   * The payments core (0173), for every provider: the submit (carrying the
   * provider's id, or its refusal), a lost answer ADOPTED from the provider's
   * own records, and a refusal landing back as a refund. Rival's names below
   * stay for the rows already written.
   */
  {
    action: 'withdrawal.provider.submit',
    label: 'Withdrawal sent to the payment provider',
    group: 'Compliance',
  },
  {
    action: 'withdrawal.provider.adopt',
    label: 'Lost payout answer recovered from the provider',
    group: 'Compliance',
  },
  {
    action: 'withdrawal.provider.reject',
    label: 'Withdrawal refused by the payment provider (refunded)',
    group: 'Compliance',
  },
  {
    action: 'deposit.settle_late',
    label: 'Deposit credited after its payment link expired',
    group: 'Compliance',
  },
  {
    action: 'deposit.credit_received',
    label: 'Flagged deposit credited with what arrived',
    group: 'Compliance',
  },
  {
    action: 'deposit.close_without_credit',
    label: 'Flagged deposit closed with no credit',
    group: 'Compliance',
  },
  {
    action: 'payment_provider.channel_enable',
    label: 'Payment channel switched on',
    group: 'Security',
  },
  {
    action: 'payment_provider.channel_disable',
    label: 'Payment channel switched off',
    group: 'Security',
  },
  {
    action: 'withdrawal.finish_paid',
    label: 'Flagged payout marked paid by a person',
    group: 'Compliance',
  },
  {
    action: 'withdrawal.finish_refund',
    label: 'Flagged payout refunded by a person',
    group: 'Compliance',
  },
  {
    action: 'payment_provider.record_acknowledge',
    label: 'Provider movement acknowledged as a company movement',
    group: 'Compliance',
  },
  {
    action: 'withdrawal.rival.submit',
    label: 'Withdrawal submitted to the payment platform',
    group: 'Compliance',
    // Written until 0173; `withdrawal.provider.submit` since.
    historical: true,
  },
  {
    action: 'withdrawal.rival.reject',
    label: 'Withdrawal refused by the payment platform (refunded)',
    group: 'Compliance',
    // Written until 0173; `withdrawal.provider.reject` since.
    historical: true,
  },
  { action: 'withdrawal.cancel', label: 'Approved withdrawal cancelled', group: 'Compliance' },

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
  /*
   * The Financial page's file: every money movement with the client named on
   * each row — client PII and money together, which is exactly the class the
   * block above says gets recorded.
   */
  { action: 'export.transactions', label: 'Financial transactions exported', group: 'Exports' },
  {
    action: 'export.trading_accounts',
    label: 'Trading accounts exported',
    group: 'Exports',
  },
  // The deposit desk's file (its own key, `deposits.view`), the ledger (the
  // reconciliation record) and the commission ledger — 6 Oct 2026.
  { action: 'export.deposits', label: 'Deposit requests exported', group: 'Exports' },
  { action: 'export.ledger', label: 'Ledger exported', group: 'Exports' },
  { action: 'export.ib_accruals', label: 'Commissions exported', group: 'Exports' },
] as const;

/** Every action key, for the coverage test and for validating `?action=`. */
export const AUDIT_ACTION_KEYS: ReadonlySet<string> = new Set(
  AUDIT_ACTIONS.map((entry) => entry.action),
);
