import { ALL_PERMISSIONS } from './support/all-permissions';
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  Actor,
  SYSTEM_ACTOR,
  actorHasPermission,
  assertActorCan,
} from '../src/common/security/actor';
import { AuthorizationError } from '../src/common/errors/domain-errors';

/**
 * PLATFORM-CONVENTIONS R-4.3 — the check belongs where the decision is made.
 *
 * Authorization lived entirely in guards, and a guard only runs on an HTTP
 * request. BullMQ is coming (ARCHITECTURE §9): the confirm job, the deal sweep,
 * mail. The moment an admin action is queued rather than executed inline, every
 * guard-only check silently stops running — and nothing fails, which is exactly
 * what makes it dangerous.
 *
 * Done now it is nearly free, because every money-moving method already receives
 * an `actor` for the audit log. Done after the queues land it is an audit of
 * every service method with no way to prove completeness.
 */

const subAdmin: Actor = {
  id: 'a-1',
  email: 'sub@oxshare.com',
  permissions: ['kyc.review', 'clients.view'],
};

const master: Actor = { id: 'a-0', email: 'master@oxshare.com', permissions: ALL_PERMISSIONS };

describe('R-4.3 actor permission checks', () => {
  it('allows an actor holding the permission', () => {
    expect(() => assertActorCan(subAdmin, 'kyc.review', 'review KYC')).not.toThrow();
  });

  it('refuses an actor who does not, with a DomainError not an HttpException', () => {
    // Services never import HTTP types; AllExceptionsFilter maps this to 403 in
    // one place. That is also what lets a queued job call the same method and
    // get a meaningful failure instead of an HTTP exception with nowhere to go.
    expect(() => assertActorCan(subAdmin, 'ib.approve', 'approve a partner application')).toThrow(
      AuthorizationError,
    );
  });

  it('names the actor, the permission and the action in the message', () => {
    // The message is read in a log during an incident, where "forbidden" alone
    // answers nothing.
    try {
      assertActorCan(subAdmin, 'ib.approve', 'approve a partner application');
      throw new Error('should have refused');
    } catch (error) {
      const message = (error as Error).message;
      expect(message).toContain('sub@oxshare.com');
      expect(message).toContain('ib.approve');
      expect(message).toContain('approve a partner application');
    }
  });

  it('honours the master wildcard', () => {
    expect(() => assertActorCan(master, 'anything.at.all', 'do anything')).not.toThrow();
  });

  it('normalizes exactly as the guard does, and no more', () => {
    /*
     * This test used to assert that `kyc:review` and `kyc.review` matched
     * interchangeably "like the guard". The guard has done no such thing since
     * migration 0009 converted the stored keys and the four `replace(/:/g, '.')`
     * shims came out — it compares the colon form as itself and refuses it.
     *
     * The premise it was written on ("two spellings are alive") stopped being
     * true, and nobody updated it, so it pinned the divergence in place: the
     * guard refused a stored `kyc:review` while the service layer accepted it,
     * and this test guarded the wrong side of exactly the mismatch its own
     * comment warned about.
     *
     * The principle survives — a second normalization that disagreed with the
     * guard's would let a route pass the edge and fail in the service, or worse,
     * pass the service having failed the edge. So the assertion is AGREEMENT
     * with the guard, not a fixed answer.
     */
    const colonStyle: Actor = { id: 'a-2', email: 'x@y.z', permissions: ['kyc:review'] };
    expect(actorHasPermission(colonStyle, 'kyc.review')).toBe(false);
    expect(actorHasPermission(subAdmin, 'KYC:REVIEW')).toBe(false);

    // Case IS folded, because a key differing only in case is a typo rather
    // than a second convention.
    expect(actorHasPermission(subAdmin, 'KYC.REVIEW')).toBe(true);
  });

  it('refuses an actor with no permissions at all', () => {
    const nobody: Actor = { id: 'a-3', email: 'nobody@oxshare.com', permissions: [] };
    expect(() => assertActorCan(nobody, 'clients.view', 'list clients')).toThrow(
      AuthorizationError,
    );
  });

  it('gives background jobs a NAMED identity, not an implicit bypass', () => {
    /*
     * A job that runs as nobody produces audit rows saying nobody did it, and a
     * permission model with an unnamed bypass is a permission model with a hole.
     *
     * The wildcard is safe for this identity in a way it would not be for a
     * person: nothing ever mints a session or a token for it, so it is reachable
     * only from code already running inside the process.
     */
    expect(SYSTEM_ACTOR.id).toMatch(/^0{8}-/);
    expect(SYSTEM_ACTOR.email).toContain('system@');
    expect(() => assertActorCan(SYSTEM_ACTOR, 'kyc.review', 'confirm accruals')).not.toThrow();
  });
});

describe('R-4.3 every money-moving service method asserts', () => {
  /*
   * The structural half, and the reason this file is not just unit tests.
   *
   * A method that FORGETS the assertion looks identical to one that never
   * needed it, exactly as an unguarded route did before R-4.2. So the rule is
   * checked mechanically: read the source of the services that move money, and
   * require every public method taking an `actor` to assert on it.
   *
   * Source reading is crude — it cannot follow a helper — but it is the right
   * crude: the failure it prevents is someone adding a method and not thinking
   * about permissions at all, and that failure is visible in the text.
   */
  const MONEY_SERVICES = [
    // `admin-money.service.ts` was the other entry and went with the money
    // teardown. The RULE outlives it: any service taking an `actor` must assert
    // on it, because a method that quietly skips the check is invisible in
    // exactly the way an unguarded route was before R-4.2. Put the money
    // services back on this list when they return, and add the IB service when
    // approving a partner becomes a privileged action.
    'src/modules/admin/admin-clients.service.ts',
  ];

  it('leaves no actor-taking method without an assertion', () => {
    const missing: string[] = [];

    for (const file of MONEY_SERVICES) {
      const source = readFileSync(join(__dirname, '..', file), 'utf8');

      // Split on method boundaries: `  async name(` at two-space indent is a
      // class member in this codebase's formatting.
      const methods = source.split(/\n {2}(?=async |private async )/);

      for (const method of methods) {
        const signature = /^(?:private )?async (\w+)\(([\s\S]*?)\)/.exec(method);
        if (!signature) continue;

        const [, name, params] = signature;
        // Only methods that receive an actor are making an authorization
        // decision. A pure read that takes no actor is not in scope here.
        if (!/actor\s*:/.test(params)) continue;
        if (method.includes('assertActorCan')) continue;

        missing.push(`${file}: ${name}()`);
      }
    }

    expect(
      missing,
      'These methods receive an actor but never assert on it. Either add ' +
        'assertActorCan(...), or stop taking an actor if the method is not making ' +
        'an authorization decision:\n' +
        missing.map((m) => `  ${m}`).join('\n'),
    ).toEqual([]);
  });

  it('actually finds methods, so the check cannot pass vacuously', () => {
    // The R-4.2 lesson: a scan that examines nothing reports a clean bill of
    // health for everything it never looked at.
    const source = readFileSync(join(__dirname, '..', MONEY_SERVICES[0]), 'utf8');
    const asserted = source.match(/assertActorCan\(/g) ?? [];
    expect(asserted.length).toBeGreaterThanOrEqual(2);
  });
});

/*
 * The R-5.4 separation-of-duties suite lived here and is gone with the money
 * routes it asserted on.
 *
 * Its point is worth keeping in view for the rebuild: approving a withdrawal
 * and PAYING it were once the same permission, which meant one admin could
 * authorise an instruction and release the funds in the same minute with one
 * name on both audit rows. "Two people must be involved in a payout" was not
 * merely unenforced, it was unexpressible — there was no second key to grant.
 *
 * Splitting the key does not by itself force two people; it makes the control
 * BUILDABLE, and whether the two are granted separately belongs to whoever
 * defines the roles. Rebuild the split, then restore this suite.
 */
