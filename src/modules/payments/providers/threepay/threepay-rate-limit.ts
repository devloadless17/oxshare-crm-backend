import { ProviderBusyError } from '../payment-provider';

/**
 * 3PAY'S REQUEST LIMITS, kept on OUR side (0174).
 *
 * 3pay allows 60 reads, 30 payment-link creations and 30 withdrawal requests a
 * minute, per merchant (guide §6.6), and answers 429 past them. A sweep can
 * ask about fifty deposits at once, so the adapter paces itself instead of
 * leaning on 429s: a sliding window per endpoint class, a little under 3pay's
 * figure, and a pause after a real 429 for as long as 3pay's `Retry-After`
 * says.
 *
 * A caller that would have to wait longer than it can afford is refused AT
 * ONCE, before anything is sent, so the refusal is a definite "nothing was
 * created" (the contract's `ProviderBusyError`). The core reads that as "stop
 * this pass, resume on the next" for a sweep, and "requeue it" for a payout.
 *
 * Per process. Two API instances each keep their own window, so together they
 * can exceed 3pay's limit; 3pay's 429 is then the backstop, and it is handled
 * the same way.
 */

/** 3pay is at its request limit (ours or its own) and nothing was sent. */
export function busy(retryAfterMs: number): ProviderBusyError {
  return new ProviderBusyError(
    `3pay is at its request limit; nothing was sent. Retry in about ${Math.ceil(
      retryAfterMs / 1000,
    )}s.`,
    retryAfterMs,
  );
}

export class SlidingWindowLimit {
  private readonly stamps: number[] = [];
  private pausedUntil = 0;

  constructor(
    private readonly perMinute: number,
    private readonly now: () => number = () => Date.now(),
    private readonly sleep: (ms: number) => Promise<void> = (ms) =>
      new Promise((resolve) => setTimeout(resolve, ms)),
  ) {}

  /**
   * Take a slot, waiting at most `patienceMs` for one. Throws a
   * `ProviderBusyError` immediately when the wait would be longer — never after
   * waiting in vain.
   */
  async take(patienceMs: number): Promise<void> {
    for (;;) {
      const now = this.now();
      while (this.stamps.length > 0 && this.stamps[0] <= now - 60_000) this.stamps.shift();
      const wait = Math.max(
        this.pausedUntil - now,
        this.stamps.length < this.perMinute ? 0 : this.stamps[0] + 60_000 - now,
      );
      if (wait <= 0) {
        this.stamps.push(now);
        return;
      }
      if (wait > patienceMs) throw busy(wait);
      patienceMs -= wait;
      await this.sleep(wait);
    }
  }

  /** 3pay answered 429: nothing more until it says so. */
  pause(ms: number): void {
    this.pausedUntil = Math.max(this.pausedUntil, this.now() + ms);
  }
}
