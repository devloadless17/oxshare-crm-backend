import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq, gte, inArray } from 'drizzle-orm';
import { startHttpTestApp, stopHttpTestApp, type HttpTestContext } from './http-setup';
import { reassertReviewPool, runSeeds } from '../src/database/seed';
import { kycSubmissions, users } from '../src/database/schema';

/**
 * A FIXTURE MAY NOT ENCODE A STATE THE PRODUCT CANNOT PRODUCE.
 *
 * `alpha@oxshare-e2e.test` shipped as `verificationLevel: 1` while carrying a
 * `submitted` KYC submission. Level 1 has exactly ONE source in this product —
 * approval — and alpha had never been approved. So the seed encoded a client who
 * was money-verified while their verification sat unreviewed.
 *
 * ## Why that is a defect and not untidiness
 *
 * `transactions.service.ts` refuses a withdrawal on `verificationLevel < 1`, so
 * seeded alpha could withdraw with their submission still in the queue. That is
 * the exact defect `kyc.service.ts` records fixing — "the status said no while
 * the money path said yes" — reproduced in fixture data. Any spec or hand-walk
 * using alpha to exercise the KYC money gate was testing a state the product
 * cannot reach, and would pass or fail for the wrong reason.
 *
 * It was invisible to everything that looked. No single surface shows a
 * contradiction: the client list shows a level, the review queue shows a status,
 * and only reading both together says they disagree. `kyc-gates-money.spec.ts`
 * mints its own clients, so it was unaffected and could not have caught it. It
 * took somebody walking a SEEDED client across two screens.
 *
 * ## The invariant is deliberately narrow
 *
 * "Level >= 1 implies an approved submission" would be the obvious rule and it
 * is too strong: `charlie` and `zulu` are level 1 with NO submission at all,
 * which is equally unproducible and has no visible consequence — a row that does
 * not exist cannot contradict one that does, and those two exist so the
 * `?level=1` filter has matches.
 *
 * What is refused is the pair that makes two surfaces tell different stories
 * about one client: a level that says verified beside a submission that says
 * still deciding.
 */

let ctx: HttpTestContext;

/** Undecided: the reviewer has not finished with it, whoever holds it. */
const UNDECIDED = ['submitted', 'under_review'] as const;

beforeAll(async () => {
  ctx = await startHttpTestApp();
  /*
   * The REAL seed against a real database, not a transcription of it. A test
   * that restated the fixture would agree with itself forever and say nothing
   * about what `runSeeds` actually writes — which is the only thing a developer
   * or a hand-walk ever sees.
   *
   * It takes no db argument: seeds run at bootstrap, outside the request
   * lifecycle, and reach the module-level `getDb()` singleton — which
   * `startHttpTestApp` has already pointed at this container.
   */
  await runSeeds();
}, 180_000);

afterAll(async () => {
  await stopHttpTestApp(ctx);
});

describe('the seeded fixtures are internally consistent', () => {
  it('has NO client who is verified while their KYC is still undecided', async () => {
    const offenders = await ctx.db.db
      .select({
        email: users.email,
        level: users.verificationLevel,
        status: kycSubmissions.status,
      })
      .from(users)
      .innerJoin(kycSubmissions, eq(kycSubmissions.userId, users.id))
      .where(and(gte(users.verificationLevel, 1), inArray(kycSubmissions.status, [...UNDECIDED])));

    expect(
      offenders,
      'a seeded client holds verificationLevel >= 1 while their submission is still ' +
        'undecided. Level 1 comes only from approval, so this is a state the product ' +
        'cannot produce — and the money gate reads the level, so the fixture can withdraw ' +
        'with their verification in the queue. Any spec using them to exercise that gate ' +
        'passes or fails for the wrong reason.',
    ).toEqual([]);
  });

  it('still gives the level filter a match on BOTH sides — the cohort’s own purpose', async () => {
    /*
     * NON-VACUITY, and it is the case that stops the fix from being a
     * regression. The cohort exists so every filter has a match and a
     * non-match; "no client is verified-while-undecided" is trivially satisfied
     * by a cohort where nobody is verified at all, which would silently delete
     * the coverage `?level=1` depends on.
     */
    const cohort = await ctx.db.db
      .select({ email: users.email, level: users.verificationLevel })
      .from(users);
    const e2e = cohort.filter((c) => c.email.endsWith('@oxshare-e2e.test'));

    expect(e2e.length, 'the e2e cohort was not seeded — this case proves nothing').toBeGreaterThan(
      3,
    );
    expect(
      e2e.some((c) => c.level >= 1),
      'no seeded client is verified, so ?level=1 has no match and the filter cannot be ' +
        'shown to do anything',
    ).toBe(true);
    expect(
      e2e.some((c) => c.level === 0),
      'every seeded client is verified, so ?level=0 has no match',
    ).toBe(true);
  });
});

describe('the review pool is re-asserted to PENDING, level included', () => {
  /*
   * ⚠️ THE CASE THE SEED-OUTPUT CHECK ABOVE STRUCTURALLY CANNOT SEE.
   *
   * `runSeeds` on a FRESH database creates every pool client at level 0, so the
   * invariant holds trivially and says nothing about the state a USED database
   * is left in. The pool exists to be DECIDED — specs approve these clients —
   * and `reassertReviewPool` is what puts them back.
   *
   * It put the SUBMISSION back and not the LEVEL. So an approval left the level
   * at 1 permanently: the next boot reset the submission to `submitted` and the
   * client stayed money-verified. The alpha contradiction, except GENERATED by
   * the reset, recurring after every run that approves a pool client.
   *
   * Measured on the dev database before the fix — `e2e-pool-decided`,
   * `e2e-pool-rt` and `e2e-pool-settle`, all level 1 with a `submitted`
   * submission. Three rows in the pool whose entire contract is "found pending
   * again next time".
   *
   * So this case APPROVES first and then resets, which is the sequence a real
   * run performs and the only one that can observe the omission.
   */
  it('puts an APPROVED pool client back to level 0, not just back to submitted', async () => {
    const db = ctx.db.db;
    const [pooled] = await db
      .select({ id: users.id, email: users.email })
      .from(users)
      .where(eq(users.email, 'e2e-pool-decided@oxshare-e2e.test'));
    expect(pooled, 'the review pool was not seeded — this case proves nothing').toBeDefined();

    // What a spec that approves this client leaves behind.
    await db.update(users).set({ verificationLevel: 1 }).where(eq(users.id, pooled.id));
    await db
      .update(kycSubmissions)
      .set({ status: 'approved' })
      .where(eq(kycSubmissions.userId, pooled.id));

    await reassertReviewPool(db);

    const [after] = await db
      .select({ level: users.verificationLevel, status: kycSubmissions.status })
      .from(users)
      .innerJoin(kycSubmissions, eq(kycSubmissions.userId, users.id))
      .where(eq(users.id, pooled.id));

    expect(after.status, 'the submission was not put back to pending').toBe('submitted');
    expect(
      after.level,
      'the submission went back to pending and the LEVEL did not. The client is ' +
        'money-verified with their verification in the queue, and every later run ' +
        'inherits it — the money gate reads the level, so a withdrawal spec using this ' +
        'client passes for the wrong reason.',
    ).toBe(0);
  });
});
