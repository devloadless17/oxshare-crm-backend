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
  }
  return [...found].sort();
}

/**
 * Every action that passes a details object today. SHRINK-ONLY in spirit: an
 * entry leaving is fine, an entry arriving needs the check in the header.
 */
const WRITES_DETAILS: readonly string[] = [
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
  'admin.update',
  'agency.create',
  'agency.delete',
  'agency.products_set',
  'agency.update',
  'api_key.create',
  'api_key.revoke',
  'client.email_change',
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
  'ib_level.create',
  'ib_level.delete',
  'ib_level.update',
  'ip_allowlist.add',
  'ip_allowlist.remove',
  'kyc.approve',
  'kyc.claim',
  'kyc.identity_correct',
  'kyc.reject',
  'kyc.release',
  'kyc_config.replace',
  'kyc_config.reset',
  'kyc_config.step_add',
  'kyc_config.step_delete',
  'kyc_config.step_update',
  'leverage.create',
  'leverage.delete',
  'payment_method.create',
  'payment_method.update',
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
  'settings.rival.update',
  'settings.rival.webhook_key.rotate',
  'settings.smtp.update',
  'settings.trading.update',
  'trading.account_create',
  'trading.deposit',
  'trading.withdraw',
  'transfer.abandon',
  'wallet.create',
  'wallet.credit',
  'wallet.delete',
  'withdrawal.rival.reject',
  'withdrawal.rival.submit',
  'withdrawal.settle',
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
