import { describe, expect, it } from 'vitest';
import 'reflect-metadata';
import { Mt5WebhooksController } from '../src/modules/trading/mt5/mt5-webhooks.controller';

/**
 * The bridge's push surface must not share a limit sized for a person.
 *
 * ## The bug this pins, which was a DATA LOSS bug and did not look like one
 *
 * The global throttle is 120 requests per minute — right for a human clicking a
 * console. The bridge's account sweep sends ONE REQUEST PER ACCOUNT every
 * `SweepIntervalSeconds` (300), at roughly 16/s observed. So a server with more
 * than ~120 accounts exhausted a human's budget about eight seconds into every
 * sweep.
 *
 * What turned that from slow into destructive is on the other side:
 * `AccountSyncWorker.DeliverAsync` treated every 4xx as a permanent rejection
 * and did not retry it — correct for 400 and 404, catastrophic for 429. The
 * accounts past the budget were DROPPED, and because the sweep pushes in a
 * stable order it was the same tail every round. Not a delay; a permanent blind
 * spot in the balance mirror, widening as the broker opened accounts, and
 * announced by nothing louder than a warning per account.
 *
 * ## Why this asserts a NUMBER and not merely "some override exists"
 *
 * The failure mode was inheriting the global limit by omission — no decorator,
 * no decision, no symptom until an account count crossed a line nobody had
 * written down. A test that only checked "is it overridden" would pass on an
 * override of 121. So it asserts the limit clears the sweep's real shape by an
 * order of magnitude, which is the property that actually keeps snapshots alive.
 *
 * `credential-route-throttling.spec.ts` reads the same metadata for the opposite
 * reason: those routes need a limit far BELOW the global one.
 */

/** How @nestjs/throttler stores a resolved `@Throttle` for the default limiter. */
const TTL = 'THROTTLER:TTL' + 'default';
const LIMIT = 'THROTTLER:LIMIT' + 'default';

/** The global limit in app.module.ts — what this surface must NOT be bound by. */
const HUMAN_LIMIT = 120;

/**
 * The sweep's real shape, from the bridge's own configuration.
 *
 * `SweepIntervalSeconds: 300`, one request per account, ~16/s observed in the
 * logs. A limit at or below the number of accounts on the server is a limit that
 * silently truncates the sweep.
 */
const OBSERVED_PUSH_RATE_PER_MINUTE = 16 * 60;

function classThrottle(controller: object): { ttl: number; limit: number } | null {
  const ttl = Reflect.getMetadata(TTL, controller) as number | undefined;
  const limit = Reflect.getMetadata(LIMIT, controller) as number | undefined;
  return ttl === undefined || limit === undefined ? null : { ttl, limit };
}

describe('the MT5 bridge webhook surface carries its own rate limit', () => {
  it('names a limit rather than inheriting the global one', () => {
    const throttle = classThrottle(Mt5WebhooksController);

    expect(
      throttle,
      'Mt5WebhooksController carries no @Throttle, so it inherits the global 120/min — a limit ' +
        'sized for a human console, applied to a sweep that sends one request per account. ' +
        'Every account past the budget is dropped by the bridge, which does not retry a 4xx.',
    ).not.toBeNull();
  });

  it('clears the sweep rate by an order of magnitude', () => {
    const throttle = classThrottle(Mt5WebhooksController)!;

    expect(throttle.limit).toBeGreaterThan(HUMAN_LIMIT);
    /*
     * The property that matters: a full minute of the sweep pushing flat out
     * must fit inside the budget with room to spare. At exactly the push rate a
     * momentary burst still truncates, and the truncation is silent.
     */
    expect(
      throttle.limit,
      `A limit of ${throttle.limit}/min does not clear the observed sweep rate of ` +
        `${OBSERVED_PUSH_RATE_PER_MINUTE}/min. Snapshots past the budget are dropped, not delayed.`,
    ).toBeGreaterThanOrEqual(OBSERVED_PUSH_RATE_PER_MINUTE * 5);
  });

  it('is still BOUNDED — raised, never removed', () => {
    const throttle = classThrottle(Mt5WebhooksController)!;

    /*
     * `BridgeSecretGuard` is what authenticates this surface, so the limit is
     * not what protects it. A ceiling still bounds a leaked secret and a bridge
     * wedged in a retry loop, and `@SkipThrottle` would have left neither.
     * "Unlimited" is not a decision anybody would make deliberately.
     */
    expect(Number.isFinite(throttle.limit)).toBe(true);
    expect(throttle.ttl).toBe(60_000);
  });
});
