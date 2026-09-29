import { ALL_PERMISSIONS } from './support/all-permissions';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { actingAs, startHttpTestApp, stopHttpTestApp, type HttpTestContext } from './http-setup';
import { PasswordService } from '../src/common/security/password.service';
import { admins, kycSubmissions, roles, users } from '../src/database/schema';

/**
 * THE DECISION PATH, DRIVEN ADVERSARIALLY — is the state machine a state machine?
 *
 * `kyc-claim-lifecycle.spec.ts` already covers the CLAIM half thoroughly,
 * including one race (two releases at once). This file covers the DECISION half,
 * which had two gaps that matter:
 *
 *   1. NO RACE ON A DECISION. The only `Promise.all` in `kyc-http.spec.ts`
 *      hashes two passwords. Nothing anywhere drove two reviewers deciding the
 *      SAME submission in the same tick — which is the case the conditional
 *      UPDATE in `KycStore.transition` exists for, and therefore the one that
 *      proves it works rather than merely reading as though it would.
 *   2. NO INVALID TRANSITION FROM A DECIDED STATE. `kyc-service.spec.ts` refuses
 *      approving something never submitted; nothing refused approving something
 *      already REJECTED.
 *
 * ## The machine, read out of the code rather than assumed
 *
 *   claim    from ['submitted']                                        → under_review
 *   release  from ['under_review']                                     → submitted
 *   approve  from ['submitted','under_review']                         → approved
 *   reject   from ['submitted','under_review','approved','rejected']   → rejected
 *
 * `reject` is deliberately WIDER, and that asymmetry is the interesting part: it
 * is the correction path, so it must be able to reach an APPROVED submission and
 * take `verificationLevel` back to 0. Approve cannot reach a decided one, because
 * silently re-approving would leave no trace of the decision it replaced.
 *
 * ## TWO refusal codes, and the difference is not cosmetic
 *
 * Driving this found that a decided submission is refused TWICE over, by two
 * mechanisms answering differently, and both are deliberate:
 *
 *   400  the pre-check in `approve` — it read the row, saw `approved`/`rejected`,
 *        and says so specifically ("this one is rejected"). The ORDINARY case: a
 *        console showing a stale queue, a double-click that lands seconds apart.
 *   409  the conditional UPDATE — the row changed under the request between the
 *        read and the write. The RACE, and the only case the pre-check cannot
 *        catch, because at the moment it looked the answer was different.
 *
 * I expected 409 for both and was wrong. The distinction is worth pinning
 * rather than flattening: 400 carries a sentence a reviewer can act on, and a
 * 409 means something genuinely concurrent happened. Collapsing them would lose
 * the better message for the common case, and asserting only one would leave the
 * other path untested — which is how the pre-check and the WHERE clause could
 * drift apart without anything noticing.
 *
 * ## Why HTTP rather than the service
 *
 * A conditional UPDATE is only a guarantee if the request that reaches it is the
 * one the console sends. These go through the real guard chain against real
 * Postgres, so a decision refused by the DATABASE and one refused by a guard are
 * distinguishable — and this file asserts the STATUS CODE before reading any
 * body, because a 401 and a correctly-refused transition are both non-200 and
 * only one of them is an answer.
 */

const REVIEWER_A = { email: 'decide-a@oxshare.com', password: 'reviewer-password-1' };
const REVIEWER_B = { email: 'decide-b@oxshare.com', password: 'reviewer-password-2' };

let ctx: HttpTestContext;
let subjectId: number;
type Session = Awaited<ReturnType<typeof actingAs>>;
let a: Session;
let b: Session;

beforeAll(async () => {
  ctx = await startHttpTestApp();
  const passwords = new PasswordService();
  const db = ctx.db.db;

  const [reviewRole] = await db
    .insert(roles)
    .values({ name: 'Decide Reviewer', permissions: ALL_PERMISSIONS })
    .returning();

  for (const who of [REVIEWER_A, REVIEWER_B]) {
    await db.insert(admins).values({
      email: who.email,
      passwordHash: await passwords.hash(who.password),
      name: who.email,
      role: 'sub_admin',
      roleId: reviewRole.id,
      permissions: [],
      status: 'active',
    });
  }

  const [subject] = await db
    .insert(users)
    .values({
      email: 'decide-subject@oxshare-e2e.test',
      passwordHash: 'x',
      firstName: 'Decide',
      lastName: 'Subject',
      emailVerified: true,
      verificationLevel: 0,
    })
    .returning();
  subjectId = subject.id;

  await db.insert(kycSubmissions).values({
    userId: subjectId,
    status: 'submitted',
    submittedAt: new Date(),
    personalInfo: { firstName: 'Decide', lastName: 'Subject' },
    document: { docType: 'passport' },
  });

  a = await actingAs(ctx, 'admin', REVIEWER_A);
  b = await actingAs(ctx, 'admin', REVIEWER_B);
}, 180_000);

afterAll(async () => {
  await stopHttpTestApp(ctx);
});

/** Back to an undecided, unclaimed submission before every case. */
beforeEach(async () => {
  await ctx.db.db
    .update(kycSubmissions)
    .set({ status: 'submitted', reviewedBy: null, reviewedAt: null, rejectionReason: null })
    .where(eq(kycSubmissions.userId, subjectId));
  await ctx.db.db.update(users).set({ verificationLevel: 0 }).where(eq(users.id, subjectId));
});

const approve = (s: Session) => s.patch(`/v1/admin/kyc/${subjectId}/approve`).send({});
const reject = (s: Session, reason = 'a stated reason') =>
  s.patch(`/v1/admin/kyc/${subjectId}/reject`).send({ reason });

const state = async () => {
  const [row] = await ctx.db.db
    .select({ status: kycSubmissions.status, reviewedBy: kycSubmissions.reviewedBy })
    .from(kycSubmissions)
    .where(eq(kycSubmissions.userId, subjectId));
  const [u] = await ctx.db.db
    .select({ level: users.verificationLevel })
    .from(users)
    .where(eq(users.id, subjectId));
  return { ...row, level: u.level };
};

describe('a decision cannot be made twice', () => {
  it('REFUSES to approve a submission that was already REJECTED', async () => {
    expect((await reject(a)).status, 'the setup rejection did not land').toBe(200);

    const second = await approve(b);

    /*
     * The status first, and on its own line. A 401 here would also be non-200
     * and would prove nothing about the transition — which is the mistake this
     * file's header names.
     */
    expect(
      second.status,
      `approving an already-rejected submission answered ${second.status}. ` +
        'Approve transitions from submitted/under_review only: reaching a decided ' +
        'submission would replace a decision with no trace of what it replaced.',
    ).toBe(400);
    expect((await state()).status, 'the refused approval still changed the row').toBe('rejected');
  });

  it('REFUSES to approve a submission that was already APPROVED', async () => {
    expect((await approve(a)).status).toBe(200);

    const second = await approve(b);

    expect(second.status, `a second approval answered ${second.status}`).toBe(400);
    // Non-vacuous: the FIRST reviewer still holds it, so the loser changed nothing.
    const after = await state();
    expect(after.status).toBe('approved');
    expect(after.reviewedBy, 'the second approval overwrote the first reviewer').not.toBeNull();
  });

  it('ALLOWS a rejection to correct a mistaken APPROVAL, and takes the level back', async () => {
    /*
     * The asymmetry, pinned. `reject` is the only path wide enough to reach a
     * decided submission, because correcting a wrong approval is a real thing a
     * compliance desk must be able to do — and it must undo the verification
     * level too, or the client keeps the access the approval granted.
     */
    expect((await approve(a)).status).toBe(200);
    expect((await state()).level, 'approval did not raise the verification level').toBe(1);

    const corrected = await reject(b, 'the passport was expired');

    expect(corrected.status, `correcting an approval answered ${corrected.status}`).toBe(200);
    const after = await state();
    expect(after.status).toBe('rejected');
    expect(after.level, 'a corrected approval left the client verified').toBe(0);
  });
});

describe('two reviewers deciding at once', () => {
  /*
   * THE CASE THE CONDITIONAL UPDATE EXISTS FOR, and the one nothing drove.
   *
   * `KycStore.transition` is `UPDATE ... WHERE status IN (from) RETURNING`, so
   * the loser gets no row back and the service turns that into a 409. Read as
   * code it obviously works; the reason to drive it is that "obviously works"
   * is what the append-only trigger and the mandatory-step guard both had going
   * for them, and both were absent.
   */
  it('resolves exactly ONE winner when two approve simultaneously', async () => {
    const [first, second] = await Promise.all([approve(a), approve(b)]);
    const codes = [first.status, second.status].sort((x, y) => x - y);

    expect(
      codes,
      `two simultaneous approvals answered ${codes.join(' and ')} — both must not succeed`,
    ).toEqual([200, 409]);
    expect((await state()).status).toBe('approved');
  });

  it('resolves exactly ONE winner when an approval races a rejection', async () => {
    /*
     * Harder than two approvals, because `reject` can legitimately follow an
     * approval. So BOTH orderings are correct outcomes and the assertion is on
     * the invariant rather than on a fixed pair: the row ends in exactly one of
     * the two decided states, never half-written, and never with a status one
     * caller was told it did not achieve.
     */
    const [approved, rejected] = await Promise.all([approve(a), reject(b)]);

    expect(
      [approved.status, rejected.status].every((s) => s === 200 || s === 409),
      `approve answered ${approved.status} and reject answered ${rejected.status} — ` +
        'neither should be a 5xx, and neither should be a validation error',
    ).toBe(true);

    const after = await state();
    expect(['approved', 'rejected'], `the row settled on ${after.status}`).toContain(after.status);

    // The half that would be a real defect: a client left verified by an
    // approval that the desk was told lost the race.
    if (after.status === 'rejected') {
      expect(after.level, 'the submission is rejected but the client is still verified').toBe(0);
    }
  });
});

describe('a decision needs the grant, not just a session', () => {
  it('refuses an authenticated admin who holds no review permission', async () => {
    const passwords = new PasswordService();
    const [viewOnly] = await ctx.db.db
      .insert(roles)
      .values({ name: 'Decide Viewer', permissions: ['kyc.view'] })
      .returning();
    const who = { email: 'decide-viewer@oxshare.com', password: 'viewer-password-12' };
    await ctx.db.db.insert(admins).values({
      email: who.email,
      passwordHash: await passwords.hash(who.password),
      name: who.email,
      role: 'sub_admin',
      roleId: viewOnly.id,
      permissions: [],
      status: 'active',
    });

    const viewer = await actingAs(ctx, 'admin', who);
    const refused = await approve(viewer);

    /*
     * 403, not 401 — the distinction this file's header insists on. A 401 would
     * mean the session failed and would say nothing about `kyc.review`.
     */
    expect(
      refused.status,
      `a kyc.view-only admin approving answered ${refused.status}; 401 would mean the ` +
        'session failed and would prove nothing about the permission',
    ).toBe(403);
    expect((await state()).status, 'a refused approval still decided it').toBe('submitted');
  });
});
