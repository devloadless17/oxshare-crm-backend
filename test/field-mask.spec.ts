import { describe, expect, it } from 'vitest';
import {
  applyMask,
  applyMaskAll,
  EMPTY_MASK,
  maskedFieldsFor,
  maskedPathsFor,
} from '../src/common/security/field-mask';

/**
 * RBAC-03 — the function between an administrator and a client's phone number.
 *
 * Every case here is one where being wrong leaks PII to someone the operator
 * believed could not see it, or blanks a field for someone who could. There is
 * no cosmetic assertion in this file.
 *
 * It is a pure seam (ARCHITECTURE §8.6) precisely so this can be exhaustive
 * without a container: every shape it can be handed, every path that is not
 * there, every value that is legitimately absent.
 */

describe('maskedPathsFor — resource prefixes', () => {
  it('returns paths for the requested resource only, prefix stripped', () => {
    const mask = ['client.email', 'client.phone', 'kyc.personalInfo.dateOfBirth'];
    expect(maskedPathsFor('client', mask)).toEqual(['email', 'phone']);
    expect(maskedPathsFor('kyc', mask)).toEqual(['personalInfo.dateOfBirth']);
  });

  it('does not let one resource claim another whose name is a prefix of it', () => {
    // A `clients.*` resource must not be swept up by `client`. The separator is
    // part of the match for exactly this reason.
    expect(maskedPathsFor('client', ['clients.email'])).toEqual([]);
  });

  it('is empty for an unmasked resource', () => {
    expect(maskedPathsFor('client', ['kyc.personalInfo.address'])).toEqual([]);
    expect(maskedPathsFor('client', EMPTY_MASK)).toEqual([]);
  });
});

describe('maskedFieldsFor — what the response tells the UI', () => {
  it('keeps the prefix, because the frontend keys off the catalog key', () => {
    // The UI renders "hidden" from these. A stripped key would not match the
    // catalog it was configured from.
    expect(maskedFieldsFor('client', ['client.email', 'kyc.personalInfo.phone'])).toEqual([
      'client.email',
    ]);
  });
});

describe('applyMask — removing values', () => {
  const client = () => ({
    id: 'c1',
    email: 'alpha@example.com',
    firstName: 'Alpha',
    lastName: 'Aardvark',
    phone: '+961 1 000 000',
    country: 'Lebanon',
  });

  it('omits a masked field entirely — not null, not a sentinel', () => {
    const masked = applyMask('client', client(), ['client.email']);

    // OMITTED. Null already means "no phone number on file", and a sentinel
    // string would be a value the frontend must remember never to display,
    // compare or format.
    expect('email' in masked).toBe(false);
    expect(masked).not.toHaveProperty('email');
  });

  it('leaves every unmasked field exactly as it was', () => {
    const masked = applyMask('client', client(), ['client.email']);
    expect(masked).toEqual({
      id: 'c1',
      firstName: 'Alpha',
      lastName: 'Aardvark',
      phone: '+961 1 000 000',
      country: 'Lebanon',
    });
  });

  it('removes several fields in one pass', () => {
    const masked = applyMask('client', client(), [
      'client.email',
      'client.phone',
      'client.country',
    ]);
    expect(Object.keys(masked).sort()).toEqual(['firstName', 'id', 'lastName']);
  });

  it('DOES NOT MUTATE the row it was given', () => {
    /*
     * Load-bearing. Rows come straight from Drizzle and may be shared with a
     * later audit write, a cache, or a second serialisation. Deleting in place
     * would make what ends up masked depend on the order consumers ran in —
     * a bug that only shows up under concurrency, on a screen nobody is
     * watching.
     */
    const row = client();
    applyMask('client', row, ['client.email']);
    expect(row.email).toBe('alpha@example.com');
  });

  it('returns the SAME reference when nothing is masked, so a page is not copied', () => {
    const row = client();
    expect(applyMask('client', row, EMPTY_MASK)).toBe(row);
    expect(applyMask('client', row, ['kyc.personalInfo.address'])).toBe(row);
  });
});

describe('applyMask — nested paths', () => {
  const submission = () => ({
    id: 's1',
    status: 'pending',
    personalInfo: {
      firstName: 'Alpha',
      phone: '+961 1 000 000',
      address: { line1: 'Rue X', city: 'Beirut' },
    },
  });

  it('removes a nested field without disturbing its siblings', () => {
    const masked = applyMask('kyc', submission(), ['kyc.personalInfo.phone']);
    expect(masked.personalInfo).toEqual({
      firstName: 'Alpha',
      address: { line1: 'Rue X', city: 'Beirut' },
    });
    expect(masked.status).toBe('pending');
  });

  it('removes a whole nested object when the key names one', () => {
    const masked = applyMask('kyc', submission(), ['kyc.personalInfo.address']);
    expect('address' in masked.personalInfo).toBe(false);
  });

  it('does not mutate the nested object either', () => {
    const row = submission();
    applyMask('kyc', row, ['kyc.personalInfo.phone']);
    expect(row.personalInfo.phone).toBe('+961 1 000 000');
  });

  it('clones only along the masked path', () => {
    // Masking three fields on a 25-row page must not deep-copy 25 rows.
    const row = submission();
    const masked = applyMask('kyc', row, ['kyc.personalInfo.phone']);
    expect(masked.personalInfo.address).toBe(row.personalInfo.address);
  });
});

describe('applyMask — shapes that are not errors', () => {
  it('is a no-op for a path the row does not have', () => {
    /*
     * The same mask is applied to a compact list row and to a full profile, and
     * the list row simply has fewer fields. Throwing here would turn "this
     * admin cannot see phone numbers" into a 500 on the one screen that never
     * showed one.
     */
    const row = { id: 'c1', email: 'a@example.com' };
    expect(applyMask('client', row, ['client.phone'])).toEqual(row);
  });

  it('is a no-op when a parent on the path is null or missing', () => {
    const row = { id: 's1', personalInfo: null };
    expect(applyMask('kyc', row, ['kyc.personalInfo.phone'])).toEqual(row);
    expect(applyMask('kyc', { id: 's1' }, ['kyc.personalInfo.phone'])).toEqual({ id: 's1' });
  });

  it('removes a field whose value is null, rather than treating null as absent', () => {
    // "Masked" and "empty" are different answers and the UI renders them
    // differently. A null that survives masking reads as "no phone on file",
    // which is a claim about the client rather than about the viewer.
    const masked = applyMask('client', { id: 'c1', phone: null }, ['client.phone']);
    expect('phone' in masked).toBe(false);
  });

  it('passes non-objects straight through', () => {
    expect(applyMask('client', null, ['client.email'])).toBeNull();
    expect(applyMask('client', undefined, ['client.email'])).toBeUndefined();
  });
});

describe('applyMaskAll — a page of rows', () => {
  it('masks every row', () => {
    const rows = [
      { id: 'a', email: 'a@example.com' },
      { id: 'b', email: 'b@example.com' },
    ];
    const masked = applyMaskAll('client', rows, ['client.email']);

    expect(masked).toHaveLength(2);
    for (const row of masked) expect('email' in row).toBe(false);
    // Originals untouched — the same non-mutation guarantee, across a page.
    expect(rows[0].email).toBe('a@example.com');
  });

  it('returns the same array when nothing is masked', () => {
    const rows = [{ id: 'a', email: 'a@example.com' }];
    expect(applyMaskAll('client', rows, EMPTY_MASK)).toBe(rows);
  });
});
