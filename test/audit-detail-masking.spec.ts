import { describe, expect, it } from 'vitest';
import { AUDIT_DETAIL_FIELDS, maskAuditDetails } from '../src/common/security/audit-detail-fields';

/**
 * RBAC-03 INSIDE the audit log, which is the one store nothing else can reach.
 *
 * `details` is free-form jsonb: no DTO for the response interceptor to walk, no
 * catalogue path for `applyMask` to remove. Most of what used to be in there was
 * denormalised context and is gone from the WRITE — `subject_id` already IS the
 * client, so the address made the row no more answerable while putting PII
 * somewhere it could not be taken back out of.
 *
 * `client.email_change` is the case that cannot be solved that way: the two
 * addresses ARE the change, and a record of an email change that does not say
 * which emails is not a record of anything. So the row keeps them and the READ
 * is narrowed instead — a redacted VIEW rather than a redacted RECORD, which is
 * the only version compatible with the log being evidence.
 */
describe('the audit log honours a field mask on the way out', () => {
  const HIDES_EMAIL = ['client.email'];

  it('removes both addresses from an email-change row', () => {
    const details = { before: 'old@x.test', after: 'new@x.test', sessionsRevoked: true };
    const masked = maskAuditDetails('client.email_change', details, HIDES_EMAIL);

    expect(JSON.stringify(masked)).not.toContain('@x.test');
    // Non-vacuous: the row still records that the change happened, and what
    // else it did — a reader who may not see the address still sees the event.
    expect(masked.sessionsRevoked).toBe(true);
  });

  it('leaves the addresses for a reader who may see them', () => {
    const details = { before: 'old@x.test', after: 'new@x.test' };
    expect(maskAuditDetails('client.email_change', details, [])).toBe(details);
    expect(maskAuditDetails('client.email_change', details, ['client.phone'])).toBe(details);
  });

  it('touches no other action, however similar its keys look', () => {
    /*
     * The reason this is a declaration and not a scan for anything containing
     * an "@": `before`/`after` are the commonest keys in this table, and on
     * every other action they hold a status, a name or a level. A heuristic
     * would blank them all.
     */
    const details = { before: 'active', after: 'suspended' };
    expect(maskAuditDetails('client.suspend', details, HIDES_EMAIL)).toBe(details);
  });

  it('does not mutate the row it was given', () => {
    // The row may be shared with a serialiser or a cache; masking in place
    // would make what got hidden depend on which consumer ran first.
    const details = { before: 'old@x.test', after: 'new@x.test' };
    maskAuditDetails('client.email_change', details, HIDES_EMAIL);
    expect(details.before).toBe('old@x.test');
  });

  it('survives a row with no details at all', () => {
    expect(maskAuditDetails('client.email_change', undefined, HIDES_EMAIL)).toBeUndefined();
    expect(maskAuditDetails('client.email_change', null, HIDES_EMAIL)).toBeNull();
  });

  it('declares a catalogue key for every mapped detail key', () => {
    /*
     * A key naming a catalogue entry that does not exist would never match a
     * reader's mask, so the declaration would look correct and mask nothing —
     * the same silent no-op a mistyped resource name produces elsewhere.
     */
    const known = new Set([
      'client.email',
      'client.phone',
      'client.firstName',
      'client.lastName',
      'client.country',
    ]);
    for (const [action, keys] of Object.entries(AUDIT_DETAIL_FIELDS)) {
      for (const [detailKey, catalogueKey] of Object.entries(keys)) {
        expect(known.has(catalogueKey), `${action}.${detailKey} -> ${catalogueKey}`).toBe(true);
      }
    }
  });
});
