import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { AUDIT_DETAIL_FIELDS } from '../src/common/security/audit-detail-fields';

/**
 * WHICH AUDIT ACTIONS WRITE A `details` PAYLOAD — frozen, so adding one is a
 * decision somebody makes rather than one that happens.
 *
 * ## What this can and cannot check
 *
 * `audit_log.details` is free-form `jsonb`. `AUDIT_DETAIL_FIELDS` names, per
 * action, which keys inside it carry a client-owned value, and `maskAuditRow`
 * hides those from a reader whose mask covers them. Exactly ONE action declares
 * anything: `client.email_change`, whose two addresses ARE the change.
 *
 * The audit called that "a convention, not a mechanism", and it was right. The
 * obvious mechanism does not work: a scan for identity-shaped KEY NAMES would
 * miss the one case that matters, because the email-change payload's keys are
 * `before` and `after`. Deciding whether a VALUE is client-owned needs types,
 * not text — `{ before: oldEmail }` and `{ before: oldStatus }` are the same
 * shape to a scanner.
 *
 * So this test does not claim to detect PII. It freezes the SET of actions that
 * write a payload at all. A new one fails here, and the failure asks the only
 * question a machine cannot: does this payload carry anything owned by the
 * client, and if so is it declared in `audit-detail-fields.ts`?
 *
 * That is worth more than it sounds. The reason `details` is nearly clean today
 * is a deliberate cleanup — most of what used to be in there was denormalised
 * context that was simply removed, because `subject_id` already IS the client.
 * Nothing was stopping the next feature putting it back.
 */

const SRC = join(__dirname, '..', 'src');

function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const full = join(dir, e.name);
    if (e.isDirectory()) return sources(full);
    return e.isFile() && e.name.endsWith('.ts') ? [full] : [];
  });
}

/** `audit.record(actorId, 'action', 'subjectType', id, { …details })`. */
function actionsWritingDetails(): string[] {
  const found = new Set<string>();
  for (const file of sources(SRC)) {
    const text = readFileSync(file, 'utf8');
    for (let i = text.indexOf('.record('); i !== -1; i = text.indexOf('.record(', i + 1)) {
      const open = text.indexOf('(', i);
      let depth = 0;
      let end = open;
      for (let j = open; j < Math.min(text.length, open + 3000); j += 1) {
        if (text[j] === '(') depth += 1;
        else if (text[j] === ')') {
          depth -= 1;
          if (depth === 0) {
            end = j;
            break;
          }
        }
      }
      const call = text.slice(open, end + 1);
      const action = /'([a-z_]+\.[a-z_.]+)'/.exec(call)?.[1];
      if (action !== undefined && call.includes('{')) found.add(action);
    }
    /*
     * A PROFILE change writes its row through `ClientProfileService.update`, and
     * a caller names its action in `audit: { action: '…' }` rather than in a
     * `.record(` call of its own. The details are always `{ before, after }` —
     * client-owned by construction — so such an action writes a payload.
     *
     * Only in a file that USES the profile service: the same `audit: { action }`
     * shape is also a route policy elsewhere (the document reads in
     * `uploads.controller.ts`), which writes no details at all.
     */
    if (text.includes('ClientProfileService')) {
      for (const match of text.matchAll(/audit:\s*\{[^}]*?action:\s*'([a-z_]+\.[a-z_.]+)'/g)) {
        found.add(match[1]);
      }
      /*
       * …or CHOOSES it from what actually changed: `audit: (changed, verification)
       * => …` (`ClientProfileService.editAsAdmin`, 28 Sep 2026 — a desk edit that
       * touches a verified detail is a correction). Missing this form is how
       * the census once lost `kyc.identity_correct` without anything else moving.
       */
      for (const match of text.matchAll(
        /audit:\s*\([^)]*\)\s*=>[\s\S]{0,400}?action:\s*'([a-z_]+\.[a-z_.]+)'/g,
      )) {
        found.add(match[1]);
      }
    }
  }
  /*
   * Rows a MIGRATION wrote, which no TypeScript call site will ever show. Named
   * with the file that writes them, and the file is checked to — so the entry
   * cannot outlive the migration it describes.
   */
  for (const [action, file] of Object.entries(WRITTEN_BY_MIGRATIONS)) {
    const sql = readFileSync(join(SRC, 'database', 'migrations', file), 'utf8');
    if (sql.includes(`'${action}'`)) found.add(action);
  }
  return [...found].sort();
}

/**
 * Audit rows written by SQL, once: 0139 consolidated every client's two copies
 * of their identity into one profile and recorded each client's before/after;
 * 0147 fitted every saved KYC form to the identity core and recorded the form
 * before and after (no client data — the form is a schema).
 */
const WRITTEN_BY_MIGRATIONS: Readonly<Record<string, string>> = {
  'client.profile_consolidated': '0139_client_profile_single_home.sql',
  'kyc_config.consolidated': '0147_kyc_identity_core.sql',
};

/**
 * Every action that passes a details object today. SHRINK-ONLY in spirit: an
 * entry leaving is fine, an entry arriving needs the check in the header.
 *
 * ⚠️ BLIND TO `recordWithin`. The scan reads `.record(` calls, so an action
 * audited INSIDE its transaction is not seen here: the money decisions
 * (`withdrawal.*`, `deposit.*`, `ib.approve`, `transaction.attention_resolve`)
 * and, since 26 Sep 2026, every change to the KYC form (`kyc_config.replace`,
 * `.reset`, `.step_*` — their payloads are the form's before/after and a
 * sentence per change, no client data). They left this list when they moved
 * into their transactions, not because they stopped writing.
 */
const WRITES_DETAILS: readonly string[] = [
  'acquisition_link.create',
  'acquisition_link.disable',
  'acquisition_link.update',
  'admin.avatar_change',
  'admin.invite',
  'admin.invite_accept',
  'admin.invite_revoke',
  'admin.password_change',
  'admin.password_reset_complete',
  'admin.password_reset_initiate',
  'admin.profile_update',
  'admin.session_displaced',
  'admin.session_revoke',
  'admin.suspend',
  // 0191: an empty payload on enrolment, the target ADMIN's address on a reset — no client data.
  'admin.totp_enroll',
  'admin.totp_reset',
  'admin.update',
  'agency.create',
  'agency.delete',
  'agency.products_set',
  'agency.update',
  'api_key.create',
  'api_key.revoke',
  'client.acquired',
  'client.email_change',
  // `{ route }` only — the search that found them, never the typed address (D-82).
  'client.lookup_hidden_email',
  'client.profile_consolidated',
  'client.profile_update',
  'client.referrer_set',
  'client.suspend',
  'client_tag.assign',
  'client_tag.create',
  'client_tag.delete',
  'client_tag.unassign',
  'client_tag.update',
  'currency.create',
  'currency.delete',
  'currency.update',
  // A deposit credited or closed (0173): the client named by `userId` (a
  // scoped key); amounts, the method, the provider reference, a desk reason —
  // nothing the client owns.
  'deposit.close_without_credit',
  'deposit.credit_received',
  'deposit.settle',
  'deposit.settle_late',
  'export.audit_log',
  'export.clients',
  'export.ib_applications',
  'export.ib_partners',
  'export.kyc',
  'export.trading_accounts',
  'export.transactions',
  'export.wallets',
  'export.withdrawals',
  'external_link.create',
  'external_link.delete',
  'ib.accrual_reverse',
  'ib.level_change',
  'ib.parent_change',
  'ib.partners.suspend',
  'ib.reject',
  // 0197: percentages before/after — no client data.
  'ib.terms_change',
  'ib_commission_type.create',
  'ib_commission_type.delete',
  'ib_commission_type.update',
  'ib_level.create',
  'ib_level.delete',
  'ib_level.update',
  'ip_allowlist.add',
  // 0192: an ADMINISTRATOR's email and the granter's reason — nothing a client owns.
  'ip_allowlist.exempt_add',
  'ip_allowlist.exempt_remove',
  'ip_allowlist.remove',
  'kyc.approve',
  'kyc.claim',
  'kyc.identity_correct',
  'kyc.reject',
  'kyc.release',
  'kyc.reverification_request',
  'kyc_config.consolidated',
  'leverage.create',
  'leverage.delete',
  // 0189: the client under `userId` (a CLIENT_ID_KEY) and the desk's own note.
  'notification.task_close',
  'payment_method.create',
  'payment_method.delete',
  'payment_method.update',
  // A channel switched (0173): provider, channel, direction, the admin's reason.
  'payment_provider.channel_enable',
  'payment_provider.enable',
  // A provider's own movement (0174) — tied to no client here, names none.
  'payment_provider.record_acknowledge',
  'payment_provider.secret_rotate',
  'payment_provider.update',
  'platform_link.set',
  'product.create',
  'product.delete',
  'product.group_attach',
  'product.group_detach',
  'product.update',
  'rejection_reason.create',
  'rejection_reason.delete',
  'rejection_reason.update',
  'role.create',
  'role.delete',
  'role.update',
  'security.denied',
  'settings.assistant.update',
  'settings.jobs.run',
  'settings.jobs.update',
  'settings.smtp.update',
  'settings.trading.update',
  'trading.account_create',
  'trading.account_link',
  'trading.account_product',
  'trading.accounts_sync',
  'trading.deposit',
  'trading.withdraw',
  'transfer.abandon',
  'wallet.create',
  'wallet.delete',
  // A person finishes a flagged payout (0174): names the client by `userId`.
  'withdrawal.finish_paid',
  'withdrawal.finish_refund',
  'withdrawal.provider.reject',
  'withdrawal.provider.submit',
  'withdrawal.settle',
  'withdrawal_method.create',
  'withdrawal_method.delete',
  'withdrawal_method.update',
];

describe('audit details payloads are declared, not accidental', () => {
  it('the set of actions writing a details payload has not changed', () => {
    expect(
      actionsWritingDetails(),
      'An audit action started (or stopped) writing a `details` payload.\n' +
        'Before updating this list, answer the question it exists to ask:\n' +
        '  does that payload carry anything OWNED BY THE CLIENT?\n' +
        'If it does, declare the keys in src/common/security/audit-detail-fields.ts\n' +
        'so `maskAuditRow` can withhold them from a masked reader — otherwise the\n' +
        'value is readable by every operator who can open the audit log, and by\n' +
        'anyone who can download it.\n' +
        'Does it NAME A CLIENT (a Portal ID)? Then use a key listed in\n' +
        '`CLIENT_ID_KEYS` (src/store/audit-log.store.ts) — since 0159 a client id\n' +
        'is a bare number and is recognised by its key alone; under any other key\n' +
        'a scoped reader is shown the Portal ID of a client outside their territory.\n' +
        'If it does not, add it here and the log stays as it is.',
    ).toEqual([...WRITES_DETAILS]);
  });

  it('every action DECLARING client-owned detail keys actually writes a payload', () => {
    /*
     * The other direction. A declaration naming an action that writes nothing is
     * a mask over a payload that does not exist — harmless, and a sign the
     * declaration has drifted from the writer it was paired with.
     */
    const writing = new Set(actionsWritingDetails());
    const declaredButSilent = Object.keys(AUDIT_DETAIL_FIELDS).filter((a) => !writing.has(a));

    expect(
      declaredButSilent,
      'These actions declare client-owned detail keys but write no details payload.',
    ).toEqual([]);
  });
});
