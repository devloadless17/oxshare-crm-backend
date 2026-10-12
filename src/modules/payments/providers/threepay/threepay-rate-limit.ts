import { ProviderBusyError } from '../payment-provider';

/**
 * 3PAY'S REQUEST LIMITS, kept on OUR side (0174; rebuilt 12 Oct 2026).
 *
 * What 3pay's server enforces was measured on its live API (12 Oct 2026), and
 * it is NOT what its PDF guide says (60 reads a minute). Every response carries
 * `RateLimit-Limit`, `RateLimit-Remaining` and `RateLimit-Reset`:
 *
 *   reads           100 per 15 minutes — ONE budget shared by every read
 *                   (verify, both lists, the payout lookup, the account)
 *   payment links    20 per 15 minutes
 *   payout requests  30 per 15 minutes
 *
 * counted per calling IP address, in fixed 15-minute windows, and counted even
 * for a request 3pay then refuses.
 *
 * So each class has a BUDGET that follows 3pay's own headers: what is left and
 * when the window ends are whatever the last response said. A call that would
 * overdraw is refused AT ONCE, before anything is sent, so the refusal is a
 * definite "nothing was created" (the contract's `ProviderBusyError`): a sweep
 * stops its pass and resumes on the next, a payout is requeued.
 *
 * ## Reads have priorities, because they share one budget
 *
 * A hundred reads in fifteen minutes is one every nine seconds. Background
 * work must never use the read a payout or a paying client needs, so a caller
 * states what the read is for and the lower two leave a reserve:
 *
 *   high    what a payout's state hangs on, and a person's Test connection
 *   normal  a deposit being checked or recovered
 *   low     the balance watch and the records audit
 *
 * Per process. Two API instances each follow the same headers, so they
 * converge on 3pay's own count; its 429 is the backstop, handled the same way.
 */

export type ThreePayPriority = 'high' | 'normal' | 'low';

/** 3pay is at its request limit (ours or its own) and nothing was sent. */
export function busy(retryAfterMs: number): ProviderBusyError {
  return new ProviderBusyError(
    `3pay is at its request limit; nothing was sent. Retry in about ${describeWait(retryAfterMs)}.`,
    retryAfterMs,
  );
}

function describeWait(ms: number): string {
  const seconds = Math.max(1, Math.ceil(ms / 1000));
  return seconds < 90 ? `${seconds}s` : `${Math.ceil(seconds / 60)} minutes`;
}

/** What one response said about its budget (`RateLimit-*`), when it said anything. */
export interface BudgetReading {
  limit?: number;
  remaining?: number;
  /** Seconds until the window ends. */
  resetSeconds?: number;
}

/** A non-negative integer header, or undefined. */
function countHeader(value: string | null): number | undefined {
  const text = value?.trim() ?? '';
  return /^\d{1,9}$/.test(text) ? Number.parseInt(text, 10) : undefined;
}

/** The `RateLimit-*` headers of a response (`get` reads one header by name). */
export function budgetReadingOf(get: (name: string) => string | null): BudgetReading {
  return {
    limit: countHeader(get('ratelimit-limit')),
    remaining: countHeader(get('ratelimit-remaining')),
    resetSeconds: countHeader(get('ratelimit-reset')),
  };
}

export class RequestBudget {
  private limit: number;
  private remaining: number;
  /** When the current window ends; 0 while no request has opened one. */
  private resetAt = 0;
  private pausedUntil = 0;

  constructor(
    limit: number,
    private readonly windowMs: number,
    /** How many requests each lower priority leaves for the ones above it. */
    private readonly reserve: Readonly<Record<ThreePayPriority, number>> = {
      high: 0,
      normal: 0,
      low: 0,
    },
    private readonly now: () => number = () => Date.now(),
  ) {
    this.limit = limit;
    this.remaining = limit;
  }

  /**
   * Take one request from the budget, or throw a `ProviderBusyError` saying
   * when the window ends. Never waits: a window is fifteen minutes.
   */
  take(priority: ThreePayPriority = 'high'): void {
    const now = this.now();
    if (this.resetAt !== 0 && now >= this.resetAt) {
      this.remaining = this.limit;
      this.resetAt = 0;
    }
    if (this.pausedUntil > now) throw busy(this.pausedUntil - now);
    if (this.remaining - this.reserve[priority] <= 0) {
      throw busy(this.resetAt === 0 ? this.windowMs : this.resetAt - now);
    }
    if (this.resetAt === 0) this.resetAt = now + this.windowMs;
    this.remaining -= 1;
  }

  /**
   * Follow what 3pay just said. Inside one window the lower of its count and
   * ours wins (answers can arrive out of order); a window that moved is taken
   * as 3pay states it.
   */
  observe(reading: BudgetReading): void {
    if (reading.limit !== undefined && reading.limit > 0) this.limit = reading.limit;
    if (reading.remaining === undefined || reading.resetSeconds === undefined) return;
    const resetAt = this.now() + reading.resetSeconds * 1000;
    const sameWindow = this.resetAt !== 0 && Math.abs(resetAt - this.resetAt) < 5000;
    this.remaining = sameWindow ? Math.min(this.remaining, reading.remaining) : reading.remaining;
    this.resetAt = resetAt;
  }

  /**
   * 3pay answered 429: nothing more for as long as it said. What is left in
   * the window is whatever its headers stated (`observe`), not assumed here.
   */
  pause(ms: number): void {
    this.pausedUntil = Math.max(this.pausedUntil, this.now() + ms);
  }

  /** What is left right now, for a log line. */
  left(): number {
    return this.resetAt !== 0 && this.now() >= this.resetAt ? this.limit : this.remaining;
  }
}
