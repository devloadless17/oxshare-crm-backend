import { Controller, Post } from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';
import { getDb } from '../../database/db';
import { reassertReviewPool } from '../../database/seed';

/**
 * PUT THE E2E REVIEW POOL BACK TO PENDING. Development only.
 *
 * ## Why this exists at all
 *
 * The pooled KYC fixtures exist to BE DECIDED — claimed, approved, rejected —
 * so a strict run consumes them. `seed.ts` re-asserts them, but only at BOOT,
 * which makes the remedy for a consumed pool "restart the backend". That is one
 * strict run per restart, and the second run of any session fails on fixtures
 * the first one decided.
 *
 * That failure is worse than it looks. It arrives as ten red tests naming
 * fixtures rather than code, which reads as a broken suite, and the cheapest way
 * to make it stop is to unset `E2E_STRICT`. Unsetting it turns every skipped
 * precondition back into a silent pass — the exact failure the flag was added to
 * prevent, reached by way of the mechanism meant to prevent it.
 *
 * ## Why it is a ROUTE and not a database call from the test process
 *
 * The obvious alternative is for Playwright's `globalSetup` to reset the rows
 * directly. It cannot: the admin repo has no `pg`, no `drizzle`, and no database
 * URL. Its whole suite drives this system through the API on purpose, so adding
 * a database client to it would give the frontend tests a second, privileged way
 * to reach state — and the first thing that would follow is a spec setting up
 * through SQL what the API refuses.
 *
 * Over HTTP it also works unchanged in both topologies, which matters because
 * `crosshost` is where the cookie split is reproduced.
 *
 * ## What keeps it from being a way to un-decide a real KYC submission
 *
 * Three things, and the first alone is sufficient:
 *
 * 1. **The module is not imported in production.** `AppModule` includes it only
 *    when `NODE_ENV !== 'production'`, the same gate Swagger and the seeds are
 *    behind. There is no route to call, not a route that refuses.
 * 2. **It takes no input.** There is no id, no email, no filter — nothing a
 *    caller can point at a client. It re-asserts a FIXED list of labels compiled
 *    into `REVIEW_POOL_LABELS`, every address built as
 *    `e2e-pool-<label>@oxshare-e2e.test`.
 * 3. **It only ever writes fixtures forward to `submitted`.** It cannot reject,
 *    approve, or alter a decision on any row outside that list.
 *
 * This is deliberately NOT a general "reset test state" endpoint. The moment it
 * takes a parameter it becomes one, and a production surface that exists to
 * serve tests is how a system ends up able to un-approve a KYC decision in an
 * environment where that must be impossible.
 */
@ApiExcludeController()
@Controller('e2e/fixtures')
export class E2eFixturesController {
  /**
   * Deliberately UNAUTHENTICATED, which is safe only because of the gate above.
   *
   * `globalSetup` runs before any storage state exists — that is its whole job —
   * so requiring an admin session would mean signing in to reset the pool, and
   * signing in is what the admin login rate limit (5/min) makes scarce. The run
   * would spend its scarcest budget on the step meant to make runs cheap.
   *
   * The protection is that the route does not exist in production, not that it
   * checks a credential. A guard here would be reassurance rather than a
   * control: anyone who can reach a development API can already sign in with the
   * seeded master admin, whose password is in the repo.
   */
  /*
   * CALLERS MUST SEND AN ORIGIN. `CsrfGuard` validates Origin on every state
   * change, session or not — deliberately, because the session-ESTABLISHING
   * routes have no cookie yet and once had no origin check at all. `@NoCsrf`
   * does NOT exempt that, by design, and this route does not ask it to.
   *
   * So globalSetup sends `Origin: <adminOrigin>` exactly as the browser would.
   * A Node `fetch` sends none by default, and the resulting refusal reads as
   * "failed anti-forgery validation" — a security finding rather than a missing
   * header, which is worth knowing before debugging it as one.
   *
   * The anti-forgery TOKEN check needs a session, and this route has none, so
   * no exemption is required beyond sending the header.
   */
  @Post('review-pool')
  async resetReviewPool(): Promise<{ reset: number }> {
    return { reset: await reassertReviewPool(getDb()) };
  }
}
