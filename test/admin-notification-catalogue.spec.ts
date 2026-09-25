import { describe, expect, it } from 'vitest';
import {
  ADMIN_NOTIFICATION_CATEGORIES,
  ADMIN_NOTIFICATION_KINDS,
  ADMIN_NOTIFICATION_KIND_LIST,
  isAdminNotificationKind,
  kindsIn,
  kindsVisibleTo,
} from '../src/common/notifications/admin-notification-catalogue';
import { CATALOG_KEYS } from '../src/common/security/actor';
import { hasOpenRule } from '../src/store/notifications.store';

/**
 * The catalogue of what may ring an admin's bell — checked for the mistakes the
 * type system cannot see, each of which would fail QUIETLY in production:
 *
 *  - a permission key that does not exist rings nobody, ever, and nothing says so;
 *  - a kind whose "still open" rule the store cannot check has every fan-out
 *    throw into the log — the task never lands at all;
 *  - a category no kind belongs to is a chip that can never hold anything.
 */

describe('the admin notification catalogue', () => {
  it('names only permission keys that exist in the catalog', () => {
    const known = new Set(CATALOG_KEYS);
    for (const [kind, spec] of Object.entries(ADMIN_NOTIFICATION_KINDS)) {
      for (const key of spec.permissions) {
        expect(known.has(key), `${kind} names unknown permission '${key}'`).toBe(true);
      }
    }
  });

  it('gives every kind an open-state rule the store can check under its lock', () => {
    for (const [kind, spec] of Object.entries(ADMIN_NOTIFICATION_KINDS)) {
      expect(
        hasOpenRule(spec.subjectKind, spec.stillOpen),
        `${kind}: no '${spec.stillOpen}' rule for a '${spec.subjectKind}' subject`,
      ).toBe(true);
    }
  });

  it('puts at least one kind in every category', () => {
    for (const category of ADMIN_NOTIFICATION_CATEGORIES) {
      expect(kindsIn(category).length, `${category} is empty`).toBeGreaterThan(0);
    }
  });

  it('rings a withdrawal request to whoever can APPROVE it — settle — or reject it', () => {
    // The recipient bug the catalogue exists to make impossible.
    expect(kindsVisibleTo(['withdrawals.settle'])).toContain('admin.withdrawal.requested');
    expect(kindsVisibleTo(['withdrawals.approve'])).toContain('admin.withdrawal.requested');
  });

  it('is any-of and case-blind, and shows nothing to an admin with no key', () => {
    expect(kindsVisibleTo(['KYC.Review'])).toEqual([
      'admin.kyc.submitted',
      'admin.kyc.resubmitted',
    ]);
    expect(kindsVisibleTo([])).toEqual([]);
  });

  it('shows every kind to an admin holding every key — none is unreachable', () => {
    expect(kindsVisibleTo(CATALOG_KEYS)).toEqual([...ADMIN_NOTIFICATION_KIND_LIST]);
  });

  it('does not read a prototype name as a kind', () => {
    expect(isAdminNotificationKind('constructor')).toBe(false);
    expect(isAdminNotificationKind('admin.kyc.submitted')).toBe(true);
  });
});
