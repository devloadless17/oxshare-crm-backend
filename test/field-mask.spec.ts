import { describe, expect, it } from 'vitest';
import { EMPTY_MASK, maskedFieldsFor, maskedPathsFor } from '../src/common/security/field-mask';

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
