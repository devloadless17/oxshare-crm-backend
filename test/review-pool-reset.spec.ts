import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq, like } from 'drizzle-orm';
import { startHttpTestApp, stopHttpTestApp, type HttpTestContext } from './http-setup';
import { E2E_POOL_DOMAIN, REVIEW_POOL_LABELS, reassertReviewPool } from '../src/database/seed';
import { admins, kycSubmissions, users } from '../src/database/schema';

/**
 * THE POOL RESET PUTS A DECIDED FIXTURE BACK, WHOLE.
 *
 * The E2E suite leases pre-seeded pending KYC submissions rather than
 * registering clients, because `POST /auth/register` is capped at 10/hour per
 * IP. Those fixtures exist to BE DECIDED, so every strict run consumes some —
 * and the reset was previously available only at backend BOOT.
 *
 * That made "restart the API" the remedy for a consumed pool, which is one
 * strict run per restart. The second run of a session then fails with red tests
 * naming fixtures rather than code, and the cheapest way to silence that is to
 * unset E2E_STRICT — which turns every skipped precondition back into a silent
 * pass. The mechanism meant to stop tests disappearing would have taught people
 * to disable the flag that stops tests disappearing.
 *
 * ## What is actually pinned here
 *
 * The half that is easy to get wrong is not `status`. It is everything else a
 * decision writes. A row put back to `submitted` while it still carries
 * `reviewedBy` is PENDING AND CLAIMED — a state no submission reaches on its
 * own — and the claim specs assert on exactly that pair ("the queue shows who
 * holds it", "a colleague can hand it back"). They would pass against a row they
 * did not create and fail later in ways that look like a claim bug.
 *
 * So this decides a fixture the way the console does, resets, and requires the
 * WHOLE decision gone.
 */

let ctx: HttpTestContext;
/** A real admin id — `reviewed_by` is an FK to `admins`, not to the client. */
let reviewerId: string;

const poolEmail = (label: string) => `e2e-pool-${label}@${E2E_POOL_DOMAIN}`;

beforeAll(async () => {
  ctx = await startHttpTestApp();
  const [reviewer] = await ctx.db.db
    .insert(admins)
    .values({
      email: `pool-reset-reviewer-${Date.now()}@oxshare.com`,
      passwordHash: 'x',
      name: 'Pool Reset Reviewer',
      role: 'sub_admin',
      permissions: [],
      status: 'active',
    })
    .returning();
  reviewerId = reviewer.id;
}, 120_000);

afterAll(async () => {
  await stopHttpTestApp(ctx);
});

describe('the review pool reset', () => {
  it('seeds a fixture for every declared label, so a lease site has one to take', async () => {
    const db = ctx.db.db;
    await reassertReviewPool(db);

    const rows = await db
      .select({ email: users.email })
      .from(users)
      .where(like(users.email, `e2e-pool-%@${E2E_POOL_DOMAIN}`));

    const seeded = new Set(rows.map((r) => r.email));
    const missing = REVIEW_POOL_LABELS.filter((l) => !seeded.has(poolEmail(l)));

    expect(
      REVIEW_POOL_LABELS.length,
      'the pool is empty — nothing below is meaningful',
    ).toBeGreaterThan(0);
    expect(missing, `these labels have no seeded fixture:\n${missing.join('\n')}`).toEqual([]);
  });

  it('puts an APPROVED fixture back to pending, and clears the whole decision', async () => {
    const db = ctx.db.db;
    await reassertReviewPool(db);

    const label = REVIEW_POOL_LABELS[0];
    const [client] = await db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.email, poolEmail(label)));
    expect(client, `no fixture for '${label}'`).toBeDefined();

    // Decide it the way a reviewer does: status, reviewer, timestamp, reason.
    const decidedAt = new Date();
    await db
      .update(kycSubmissions)
      .set({
        status: 'approved',
        reviewedAt: decidedAt,
        reviewedBy: reviewerId,
        rejectionReason: 'a reason from a previous run',
        rejectedFields: ['doc_front', 'selfie'],
      })
      .where(eq(kycSubmissions.userId, client.id));

    // Non-vacuous: prove it really is decided before asserting the reset undid it.
    const [before] = await db
      .select({
        status: kycSubmissions.status,
        reviewedBy: kycSubmissions.reviewedBy,
      })
      .from(kycSubmissions)
      .where(eq(kycSubmissions.userId, client.id));
    expect(before.status).toBe('approved');
    expect(before.reviewedBy).toBe(reviewerId);

    await reassertReviewPool(db);

    const [after] = await db
      .select({
        status: kycSubmissions.status,
        reviewedAt: kycSubmissions.reviewedAt,
        reviewedBy: kycSubmissions.reviewedBy,
        rejectionReason: kycSubmissions.rejectionReason,
        rejectedFields: kycSubmissions.rejectedFields,
      })
      .from(kycSubmissions)
      .where(eq(kycSubmissions.userId, client.id));

    expect(after.status, 'the fixture is still decided').toBe('submitted');
    // The half that matters: pending AND claimed is a state nothing else creates.
    expect(after.reviewedBy, 'reset to pending but still claimed by a reviewer').toBeNull();
    expect(after.reviewedAt, 'reset to pending but still carrying a decision time').toBeNull();
    expect(after.rejectionReason, 'reset to pending but still carrying a rejection').toBeNull();
    // A resubmission clears what was returned (`submit()`); the reset must too.
    expect(after.rejectedFields, 'reset to pending but still carrying returned items').toBeNull();
  });

  it('re-activates a fixture a spec suspended, so the next run can still sign in', async () => {
    const db = ctx.db.db;
    await reassertReviewPool(db);

    const label = REVIEW_POOL_LABELS[1];
    await db
      .update(users)
      .set({ status: 'suspended', emailVerified: false })
      .where(eq(users.email, poolEmail(label)));

    await reassertReviewPool(db);

    const [after] = await db
      .select({ status: users.status, emailVerified: users.emailVerified })
      .from(users)
      .where(eq(users.email, poolEmail(label)));

    expect(after.status, 'a suspended fixture cannot sign in next run').toBe('active');
    expect(after.emailVerified, 'an unverified fixture cannot sign in next run').toBe(true);
  });

  it('touches nothing outside the e2e pool', async () => {
    /*
     * The safety property, asserted rather than argued. The function takes no
     * input and builds every address from a compiled-in label, so it CANNOT
     * name another row — but that is a claim about the code, and this is the
     * assertion that would notice if a future edit added a filter that widened.
     */
    const db = ctx.db.db;
    const [outsider] = await db
      .insert(users)
      .values({
        email: `not-a-fixture-${Date.now()}@real-client.test`,
        passwordHash: 'x',
        firstName: 'Real',
        lastName: 'Client',
        emailVerified: false,
        status: 'suspended',
      })
      .returning();

    await db.insert(kycSubmissions).values({
      userId: outsider.id,
      status: 'approved',
      submittedAt: new Date(),
      reviewedAt: new Date(),
      reviewedBy: reviewerId,
      personalInfo: { firstName: 'Real' },
      document: { docType: 'passport' },
    });

    await reassertReviewPool(db);

    const [stillDecided] = await db
      .select({ status: kycSubmissions.status, reviewedBy: kycSubmissions.reviewedBy })
      .from(kycSubmissions)
      .where(eq(kycSubmissions.userId, outsider.id));
    const [stillSuspended] = await db
      .select({ status: users.status })
      .from(users)
      .where(and(eq(users.id, outsider.id)));

    expect(stillDecided.status, 'the reset un-approved a real submission').toBe('approved');
    expect(stillDecided.reviewedBy, 'the reset cleared a real reviewer').toBe(reviewerId);
    expect(stillSuspended.status, 'the reset re-activated a suspended real client').toBe(
      'suspended',
    );
  });
});
