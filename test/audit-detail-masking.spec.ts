import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { AUDIT_DETAIL_FIELDS, maskAuditDetails } from '../src/common/security/audit-detail-fields';
import { PROFILE_FIELD_KEYS } from '../src/common/profile/client-profile';

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
     *
     * Read from the catalogue itself rather than a list typed here: a list
     * here is a second copy, and the one that would be kept up to date is the
     * catalogue.
     */
    const catalogue = JSON.parse(
      readFileSync(join(__dirname, '..', 'src', 'config', 'client-fields.json'), 'utf8'),
    ) as Record<string, { fields?: { key: string }[] }>;
    const known = new Set(
      Object.values(catalogue).flatMap((group) =>
        Array.isArray(group?.fields) ? group.fields.map((field) => field.key) : [],
      ),
    );
    expect(known.size, 'the catalogue parsed').toBeGreaterThan(10);

    for (const [action, keys] of Object.entries(AUDIT_DETAIL_FIELDS)) {
      for (const [detailKey, declaration] of Object.entries(keys)) {
        const pairs: [string, string][] =
          typeof declaration === 'string'
            ? [[detailKey, declaration]]
            : Object.entries(declaration).map(([field, key]) => [`${detailKey}.${field}`, key]);
        for (const [where, catalogueKey] of pairs) {
          expect(known.has(catalogueKey), `${action}.${where} -> ${catalogueKey}`).toBe(true);
        }
      }
    }
  });
});

/**
 * THE PROFILE'S OWN CHANGES (0139) — every profile write records
 * `{ before: {…}, after: {…} }` holding exactly the fields that moved, so the
 * audit log is the one screen that lists every value a client has ever had.
 * A reader masked from a field must not read it there either.
 */
describe('a profile change in the audit log is masked FIELD BY FIELD', () => {
  const row = {
    before: { firstName: 'Old', dateOfBirth: '1990-01-01', phone: '+96170123456' },
    after: { firstName: 'New', dateOfBirth: '1991-02-02', phone: '+96171999999' },
    via: 'admin_edit',
  };

  it.each(['client.profile_update', 'kyc.identity_correct'])(
    '%s: hides the masked field on both sides and keeps the rest',
    (action) => {
      const masked = maskAuditDetails(action, row, ['client.dateOfBirth']);
      expect(masked.before).toEqual({ firstName: 'Old', phone: '+96170123456' });
      expect(masked.after).toEqual({ firstName: 'New', phone: '+96171999999' });
      // What kind of change it was is not the client's data, and stays.
      expect(masked.via).toBe('admin_edit');
      expect(JSON.stringify(masked)).not.toMatch(/1990-01-01|1991-02-02/);
    },
  );

  it('hides every field a fully masked reader may not see — an empty change, not a leak', () => {
    const everything = ['client.firstName', 'client.dateOfBirth', 'client.phone'];
    const masked = maskAuditDetails('client.profile_update', row, everything);
    expect(masked.before).toEqual({});
    expect(masked.after).toEqual({});
  });

  it('covers what the one-time merge discarded, too', () => {
    const merged = {
      source: 'kyc_submissions.personal_info — migration 0139',
      after: { nationality: 'Lebanese' },
      discarded: { dateOfBirth: '1990-02-31', nationality: 'Lebanon' },
    };
    const masked = maskAuditDetails('client.profile_consolidated', merged, ['client.dateOfBirth']);
    expect(masked.discarded).toEqual({ nationality: 'Lebanon' });
    expect(masked.after).toEqual({ nationality: 'Lebanese' });
    expect(masked.source).toBe(merged.source);
  });

  it('returns the SAME row to a reader who may see everything', () => {
    expect(maskAuditDetails('client.profile_update', row, [])).toBe(row);
    expect(maskAuditDetails('client.profile_update', row, ['client.email'])).toBe(row);
  });

  it('declares every profile field, so a field added later is masked from day one', () => {
    for (const action of ['client.profile_update', 'kyc.identity_correct']) {
      const declared = AUDIT_DETAIL_FIELDS[action]?.['after'];
      expect(typeof declared).toBe('object');
      expect(Object.keys(declared as Record<string, string>).sort()).toEqual(
        [...PROFILE_FIELD_KEYS].sort(),
      );
    }
  });
});
