import { describe, expect, it } from 'vitest';
import { refuseReset, RESET_TOKEN_TTL_MS } from '../src/modules/admin/admin-reset';

/**
 * The escalation guard on admin password reset.
 *
 * A reset capability is impersonation: whoever can reset an admin's password
 * can become them, on a console that approves payouts. So these are not
 * ergonomics tests — every `refuseReset` returning null is somebody able to sign
 * in as somebody else, and the ones that matter most are the refusals.
 *
 * No database and no HTTP, deliberately (DECISIONS D-44). The guard is a pure
 * function precisely so each branch is asserted directly rather than through a
 * fixture that has to be believed.
 */

const master = { id: 'm1', role: 'master_admin' as const, permissions: ['*'] };
const otherMaster = { id: 'm2', role: 'master_admin' as const, permissions: ['*'] };
const manager = {
  id: 's1',
  role: 'sub_admin' as const,
  permissions: ['admins.manage', 'kyc.review'],
};
const peer = { id: 's2', role: 'sub_admin' as const, permissions: ['kyc.review'] };

describe('refuseReset', () => {
  it('lets a master reset an ordinary admin', () => {
    expect(refuseReset(master, peer)).toBeNull();
  });

  it('lets a master reset ANOTHER master — masters are peers (D-44)', () => {
    /*
     * Resolved deliberately, with the cost accepted: forbidding it would leave
     * a sole locked-out master with no way back except the database, which is
     * the situation this feature exists to remove. What makes it survivable is
     * that every reset is audited and the target's sessions all die.
     */
    expect(refuseReset(master, otherMaster)).toBeNull();
  });

  it('REFUSES a sub-admin reaching a master, however well permissioned', () => {
    // The headline failure. A permission check alone would allow this, look
    // correct in review, and hand the whole console to anyone with admins.manage.
    expect(refuseReset(manager, master)).toBe('target-is-master');
  });

  it('refuses a sub-admin whose target holds a permission they lack', () => {
    /*
     * The ladder: grant yourself nothing, reset somebody who has more, sign in
     * as them. Closed by comparing the permission SETS rather than trusting the
     * role, because two sub-admins are not automatically peers.
     */
    const higher = {
      id: 's3',
      role: 'sub_admin' as const,
      permissions: ['kyc.review', 'payouts.approve'],
    };
    expect(refuseReset(manager, higher)).toBe('target-outranks-actor');
  });

  it('allows a sub-admin to reset a strictly lesser peer', () => {
    // The case the feature is actually for: a team lead unlocking their own
    // team. Anything stricter would make the feature useless and push people
    // back to editing the database.
    expect(refuseReset(manager, peer)).toBeNull();
  });

  it('refuses a sub-admin with no admins.manage grant at all', () => {
    expect(refuseReset(peer, { ...peer, id: 'other' })).toBe('actor-not-permitted');
  });

  it('refuses everyone resetting THEMSELVES, including a master', () => {
    /*
     * Checked before any privilege reasoning, because a master passes every
     * other branch. Without it the highest privilege in the system would be the
     * one able to skip proof-of-password on its own account — so a stolen
     * session becomes a permanent one, silently.
     */
    expect(refuseReset(master, master)).toBe('self');
    expect(refuseReset(manager, manager)).toBe('self');
  });

  it('treats a wildcard permission as master, whatever the role column says', () => {
    // The two ways to be all-powerful must not disagree. A row carrying ['*']
    // with role 'sub_admin' is a master in everything but name, in both
    // directions: it may reset, and it may not be reset by a lesser admin.
    const wildcardSub = { id: 'w1', role: 'sub_admin' as const, permissions: ['*'] };
    expect(refuseReset(wildcardSub, peer)).toBeNull();
    expect(refuseReset(manager, wildcardSub)).toBe('target-is-master');
  });
});

describe('RESET_TOKEN_TTL_MS', () => {
  it('is far shorter than an invite, because the situation is different', () => {
    // An invite waits for someone to notice mail from a company they have not
    // joined; a reset is awaited by a colleague who is usually on the phone.
    const inviteTtl = 48 * 60 * 60 * 1000;
    expect(RESET_TOKEN_TTL_MS).toBeLessThan(inviteTtl);
    // And long enough to be usable rather than a race.
    expect(RESET_TOKEN_TTL_MS).toBeGreaterThanOrEqual(15 * 60 * 1000);
  });
});
