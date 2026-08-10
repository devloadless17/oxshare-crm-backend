import { ALL_PERMISSIONS } from './support/all-permissions';
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

const master = { id: 'm1', role: 'master_admin' as const, permissions: ALL_PERMISSIONS };
const otherMaster = { id: 'm2', role: 'master_admin' as const, permissions: ALL_PERMISSIONS };
/*
 * `admins.reset`, not `admins.create` — the grant the guard actually reads.
 *
 * The permission rework renamed the admin-management key and this fixture kept
 * the old one, so `manager` was refused at `actor-not-permitted` before any of
 * the outranking logic ran. Two tests below are ABOUT that logic, so they were
 * asserting a branch they never reached — the failure mode a stale fixture
 * produces: not a wrong answer, a question never asked.
 */
const manager = {
  id: 's1',
  role: 'sub_admin' as const,
  permissions: ['admins.reset', 'kyc.review'],
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
    // correct in review, and hand the whole console to anyone with users.create.
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
      permissions: ['kyc.review', 'ib.approve'],
    };
    expect(refuseReset(manager, higher)).toBe('target-outranks-actor');
  });

  it('allows a sub-admin to reset a strictly lesser peer', () => {
    // The case the feature is actually for: a team lead unlocking their own
    // team. Anything stricter would make the feature useless and push people
    // back to editing the database.
    expect(refuseReset(manager, peer)).toBeNull();
  });

  it('refuses a sub-admin with no admin-management grant at all', () => {
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

  it('treats a fully-permissioned sub-admin as unreachable, whatever the role column says', () => {
    /*
     * The two ways to be all-powerful must not disagree. A row carrying every
     * catalogue key with role 'sub_admin' is a master in everything but name,
     * in both directions: it may reset, and it may not be reset by a lesser
     * admin.
     *
     * The REASON changed and the protection did not. This asserted
     * 'target-is-master', which came from the guard's `permissions.includes('*')`
     * short-circuit — and the wildcard is gone, so a fully-permissioned admin
     * now holds a real list of real keys instead. A lesser admin is refused by
     * the subset ladder rather than by the master branch, which is the same
     * refusal arrived at honestly: it is refused for holding LESS, rather than
     * for the target carrying a symbol that meant everything forever.
     */
    const fullyPermissioned = {
      id: 'w1',
      role: 'sub_admin' as const,
      permissions: ALL_PERMISSIONS,
    };
    expect(refuseReset(fullyPermissioned, peer)).toBeNull();
    expect(refuseReset(manager, fullyPermissioned)).toBe('target-outranks-actor');
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
