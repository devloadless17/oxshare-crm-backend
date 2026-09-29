import { ALL_PERMISSIONS } from './support/all-permissions';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import {
  actingAs,
  startHttpTestApp,
  stopHttpTestApp,
  type HttpTestContext,
  type Session,
} from './http-setup';
import { PasswordService } from '../src/common/security/password.service';
import {
  adminClientTagScopes,
  admins,
  auditLog,
  clientTags,
  kycSubmissions,
  roles,
  users,
} from '../src/database/schema';

/**
 * THE CLAIM, end to end — taking one, seeing who has it, and handing it back.
 *
 * A claim was a one-way door. `submitted → under_review` had no reverse, the
 * queue never said WHO held a row, and the Claim button disappeared for
 * everyone else — so a reviewer who picked one up and could not finish it
 * (reassigned, off shift, or moved out of that territory by an administrator)
 * left work that looked taken, by nobody in particular, for ever.
 *
 * The rule these cases pin: **you may release what you could decide.** That
 * sentence is unchanged; what it means moved, because `approve` and `reject`
 * gained a claim guard and this route did not follow. They now refuse a
 * submission another reviewer holds, so "release what you could decide" stopped
 * meaning "anyone may release" on the day they changed — and for a while a
 * claim the other two enforced could be removed by anybody, which took the lock
 * off its hinges rather than leaving it advisory.
 *
 * So: a reviewer may always hand back their OWN claim, and handing back a
 * colleague's needs `kyc.claim.override`. The override is not ceremony. Because
 * approve and reject are holder-only, release is the ONLY way back to the
 * queue, and locking it without an escape would turn a reviewer who leaves mid
 * claim into a client who can never be verified.
 */

const MASTER = { email: 'claim-master@oxshare.com', password: 'admin-password-123' };
const REVIEWER = { email: 'claim-reviewer@oxshare.com', password: 'reviewer-password-1' };
const OTHER_REVIEWER = { email: 'claim-other@oxshare.com', password: 'reviewer-password-2' };
/** Holds `kyc.view` but NOT `kyc.review` — may look, may not take or release. */
const VIEWER = { email: 'claim-viewer@oxshare.com', password: 'viewer-password-12' };
/** Scoped to a tag the subject does not carry. */
const OUTSIDER = { email: 'claim-outsider@oxshare.com', password: 'outsider-password' };

let ctx: HttpTestContext;
let subjectId: string;
let reviewerId: string;

beforeAll(async () => {
  ctx = await startHttpTestApp();
  const passwords = new PasswordService();

  const [masterRole] = await ctx.db.db
    .insert(roles)
    .values({ name: 'Claim Master', permissions: ALL_PERMISSIONS, isSystem: true })
    .returning();
  const [reviewRole] = await ctx.db.db
    .insert(roles)
    .values({ name: 'Claim Reviewer', permissions: ['kyc.review', 'kyc.view'], isSystem: false })
    .returning();
  const [viewRole] = await ctx.db.db
    .insert(roles)
    .values({ name: 'Claim Viewer', permissions: ['kyc.view'], isSystem: false })
    .returning();

  const mk = async (who: { email: string; password: string }, name: string, roleId: string) =>
    (
      await ctx.db.db
        .insert(admins)
        .values({
          email: who.email,
          passwordHash: await passwords.hash(who.password),
          name,
          role: 'sub_admin',
          roleId,
          permissions: [],
        })
        .returning()
    )[0];

  await mk(MASTER, 'Claim Master', masterRole.id);
  const reviewer = await mk(REVIEWER, 'Rita Reviewer', reviewRole.id);
  reviewerId = reviewer.id;
  await mk(OTHER_REVIEWER, 'Omar Other', reviewRole.id);
  await mk(VIEWER, 'Vera Viewer', viewRole.id);
  const outsider = await mk(OUTSIDER, 'Olga Outsider', reviewRole.id);

  const [subject] = await ctx.db.db
    .insert(users)
    .values({
      email: 'claim-subject@oxshare.com',
      passwordHash: await passwords.hash('client-password-123'),
      firstName: 'Claim',
      lastName: 'Subject',
      emailVerified: true,
    })
    .returning();
  subjectId = subject.id;

  /*
   * The outsider is scoped to a tag the subject does NOT carry, and has no
   * intake grant — so every route about this client answers 404 for them.
   * Without the scope row they would be unrestricted and prove nothing.
   */
  const [foreignTag] = await ctx.db.db
    .insert(clientTags)
    .values({ slug: 'claim-foreign', label: 'Claim Foreign' })
    .returning();
  await ctx.db.db.insert(adminClientTagScopes).values({
    adminId: outsider.id,
    tagId: foreignTag.id,
    createdBy: outsider.id,
  });
  await ctx.db.db.update(admins).set({ seesUntriaged: false }).where(eq(admins.id, outsider.id));

  await ctx.db.db.insert(kycSubmissions).values({
    userId: subjectId,
    status: 'submitted',
    submittedAt: new Date(),
  });
}, 120_000);

afterAll(async () => {
  await stopHttpTestApp(ctx);
});

/** Back to an unclaimed submission before every case. */
beforeEach(async () => {
  await ctx.db.db
    .update(kycSubmissions)
    .set({ status: 'submitted', reviewedBy: null, reviewedAt: null })
    .where(eq(kycSubmissions.userId, subjectId));
});

const statusRow = async () =>
  (
    await ctx.db.db
      .select({ status: kycSubmissions.status, reviewedBy: kycSubmissions.reviewedBy })
      .from(kycSubmissions)
      .where(eq(kycSubmissions.userId, subjectId))
  )[0];

const claim = (s: Session) => s.patch(`/v1/admin/kyc/${subjectId}/claim`, {});
const release = (s: Session) => s.patch(`/v1/admin/kyc/${subjectId}/release`, {});

describe('taking a claim', () => {
  it('moves it to under_review and records who holds it', async () => {
    const reviewer = await actingAs(ctx, 'admin', REVIEWER);
    expect((await claim(reviewer)).status).toBe(200);

    const row = await statusRow();
    expect(row.status).toBe('under_review');
    expect(row.reviewedBy).toBe(reviewerId);
  });

  it('refuses a second claim, so two reviewers cannot both own it', async () => {
    const reviewer = await actingAs(ctx, 'admin', REVIEWER);
    const other = await actingAs(ctx, 'admin', OTHER_REVIEWER);
    expect((await claim(reviewer)).status).toBe(200);

    const second = await claim(other);
    expect(second.status).toBeGreaterThanOrEqual(400);
    // Still the FIRST reviewer's — a refused claim must not move the holder.
    expect((await statusRow()).reviewedBy).toBe(reviewerId);
  });
});

describe('handing a claim back', () => {
  it('returns it to the queue and detaches the reviewer', async () => {
    /*
     * `reviewedBy` cleared matters as much as the status. A row back in the
     * pool that still names a reviewer is exactly the confusion this feature
     * exists to remove.
     */
    const reviewer = await actingAs(ctx, 'admin', REVIEWER);
    await claim(reviewer);

    const res = await release(reviewer);
    expect(res.status).toBe(200);

    const row = await statusRow();
    expect(row.status).toBe('submitted');
    expect(row.reviewedBy).toBeNull();
  });

  it("REFUSES another reviewer handing back a colleague's claim", async () => {
    /*
     * The reported defect. Omar cannot approve or reject this row — the claim
     * guard refuses him — but he could hand it back, which drops the claim and
     * lets the next person decide the identity Sara was midway through
     * verifying. A guard the neighbouring route can undo is not a guard.
     */
    const reviewer = await actingAs(ctx, 'admin', REVIEWER);
    const other = await actingAs(ctx, 'admin', OTHER_REVIEWER);
    await claim(reviewer);

    const res = await release(other);
    expect(res.status, 'a colleague released a claim they do not hold').toBe(409);
    expect(
      (res.body as { message: string }).message,
      'the refusal must name the holder, or it cannot be acted on',
    ).toMatch(/reviewing this submission/i);
    expect((await statusRow()).reviewedBy, 'the claim was dropped anyway').toBe(reviewerId);
  });

  it('lets an overriding reviewer take back a claim nobody is coming back to', async () => {
    /*
     * The escape hatch, and why it must exist: approve and reject are already
     * holder-only, so without this a reviewer who claims a submission and then
     * leaves strands that client's verification for ever. `kyc.claim.override`
     * is a SEPARATE permission so that taking a colleague's work is something a
     * role is granted, never something `kyc.review` does by accident.
     */
    const reviewer = await actingAs(ctx, 'admin', REVIEWER);
    const master = await actingAs(ctx, 'admin', MASTER);
    await claim(reviewer);

    expect((await release(master)).status).toBe(200);
    expect((await statusRow()).reviewedBy).toBeNull();
  });

  it('refuses one that is already waiting in the queue', async () => {
    const reviewer = await actingAs(ctx, 'admin', REVIEWER);
    const res = await release(reviewer);
    expect(res.status).toBe(400);
    expect((res.body as { message: string }).message).toMatch(/already waiting/i);
  });

  it('refuses to reopen a DECIDED submission', async () => {
    /*
     * The line this endpoint must not cross. Reopening a verification is
     * `reject`'s job, with a reason attached and an audit row that says what
     * changed — not a silent slide back into the queue that leaves no trace of
     * what was decided or why.
     */
    const reviewer = await actingAs(ctx, 'admin', REVIEWER);
    await claim(reviewer);
    expect((await reviewer.patch(`/v1/admin/kyc/${subjectId}/approve`, {})).status).toBe(200);

    const res = await release(reviewer);
    expect(res.status).toBe(400);
    expect((await statusRow()).status).toBe('approved');
  });

  it("answers 404 for a client outside the actor's territory, never 403", async () => {
    // The same shape as every other by-id route: an out-of-scope client must
    // not be distinguishable from one that does not exist.
    const reviewer = await actingAs(ctx, 'admin', REVIEWER);
    await claim(reviewer);

    const outsider = await actingAs(ctx, 'admin', OUTSIDER);
    expect((await release(outsider)).status).toBe(404);
    expect((await statusRow()).reviewedBy).toBe(reviewerId);
  });

  it('refuses an admin who may LOOK but not review', async () => {
    const reviewer = await actingAs(ctx, 'admin', REVIEWER);
    await claim(reviewer);

    const viewer = await actingAs(ctx, 'admin', VIEWER);
    expect((await release(viewer)).status).toBe(403);
    expect((await statusRow()).reviewedBy).toBe(reviewerId);
  });

  it('resolves exactly one winner when two release at once', async () => {
    /*
     * The expected status goes in the UPDATE's WHERE clause, so the race is
     * settled by the database rather than by whoever read first. Both callers
     * saw `under_review`; only one row can match.
     */
    const reviewer = await actingAs(ctx, 'admin', REVIEWER);
    /*
     * The HOLDER and an OVERRIDER, because both must be able to win for the
     * race to mean anything. Racing the holder against a reviewer who is now
     * refused outright would leave exactly one 200 whatever the database did,
     * and the case would pass without testing the WHERE clause at all.
     */
    const master = await actingAs(ctx, 'admin', MASTER);
    await claim(reviewer);

    const results = await Promise.all([release(reviewer), release(master)]);
    const ok = results.filter((r) => r.status === 200);
    expect(ok, 'a double release must not both succeed').toHaveLength(1);
    expect((await statusRow()).status).toBe('submitted');
  });

  it('writes an audit row naming who released it and whose claim it was', async () => {
    /*
     * The row THIS case writes, identified by what was NOT there before it.
     *
     * Reading "the last row" made the assertion depend on which earlier case
     * ran first — it passed on one run and failed on the next. Clearing the
     * table instead is refused, and rightly: `audit_log` is append-only,
     * enforced by a trigger (D-21), because "an audit entry recorded in error
     * is itself a fact". So the isolation has to come from the reader, not
     * from deleting history — which is also how anyone querying this trail in
     * production has to work.
     */
    const before = new Set(
      (
        await ctx.db.db
          .select({ id: auditLog.id })
          .from(auditLog)
          .where(eq(auditLog.action, 'kyc.release'))
      ).map((r) => r.id),
    );

    const reviewer = await actingAs(ctx, 'admin', REVIEWER);
    /*
     * An OVERRIDER, because `ownClaim: false` is the interesting audit row and
     * only an overriding reviewer can produce one now. A plain colleague is
     * refused before any release is recorded.
     */
    const master = await actingAs(ctx, 'admin', MASTER);
    expect((await claim(reviewer)).status).toBe(200);
    expect((await release(master)).status).toBe(200);

    /*
     * POLLED, because the write is fire-and-forget.
     *
     * Every `audit.record` in this service is un-awaited, approve and reject
     * included — a reviewer's action is not held up by its own bookkeeping.
     * The row lands a moment after the response, so a single read races it.
     * Asserting the convention rather than changing it: making release the one
     * awaited writer would be an inconsistency nobody could explain later.
     */
    const freshRows = async () =>
      (await ctx.db.db.select().from(auditLog).where(eq(auditLog.action, 'kyc.release'))).filter(
        // By WHO released it too: an earlier case's own fire-and-forget release
        // row can land after `before` was read, and it names the same subject.
        (r) => r.subjectId === subjectId && !before.has(r.id) && r.actorEmail === MASTER.email,
      );
    const deadline = Date.now() + 5_000;
    let fresh = await freshRows();
    while (fresh.length === 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 50));
      fresh = await freshRows();
    }

    expect(fresh, 'the release was not audited exactly once').toHaveLength(1);
    const details = fresh[0].details as { releasedFrom?: string; ownClaim?: boolean };
    // Taking a colleague's claim back is the interesting case, so the row says so.
    expect(details.releasedFrom).toBe(reviewerId);
    expect(details.ownClaim).toBe(false);
  });
});

describe('who is holding it', () => {
  it('names the holder on the detail and on the queue', async () => {
    const reviewer = await actingAs(ctx, 'admin', REVIEWER);
    await claim(reviewer);

    const master = await actingAs(ctx, 'admin', MASTER);
    const detail = await master.get(`/v1/admin/kyc/${subjectId}`);
    expect((detail.body as { reviewedByName?: string }).reviewedByName).toBe('Rita Reviewer');

    const queue = await master.get('/v1/admin/kyc?status=under_review&limit=100');
    const row = (queue.body as { items: { userId: string; reviewedByName?: string }[] }).items.find(
      (i) => i.userId === subjectId,
    );
    expect(row?.reviewedByName, 'the queue does not say who has it').toBe('Rita Reviewer');
  });

  it('says nobody when it is unclaimed, rather than a stale name', async () => {
    const master = await actingAs(ctx, 'admin', MASTER);
    const detail = await master.get(`/v1/admin/kyc/${subjectId}`);
    expect((detail.body as { reviewedByName?: string | null }).reviewedByName).toBeNull();
  });

  it('still says nobody after a release', async () => {
    const reviewer = await actingAs(ctx, 'admin', REVIEWER);
    await claim(reviewer);
    await release(reviewer);

    const master = await actingAs(ctx, 'admin', MASTER);
    const detail = await master.get(`/v1/admin/kyc/${subjectId}`);
    expect((detail.body as { reviewedByName?: string | null }).reviewedByName).toBeNull();
  });
});
