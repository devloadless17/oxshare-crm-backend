/**
 * How often ONE address may be mailed, whoever asks.
 *
 * The routes' throttles count per IP, so a caller spreading requests across
 * many addresses could otherwise fill somebody's inbox with our mail — and a
 * flooded client taps Unsubscribe, which (Brevo) cuts them off from every email
 * we send, password resets and deposit receipts included. This caps the
 * RECIPIENT instead: `perHour` bounds how much, `minGapMs` how fast.
 *
 * Held in memory: a restart forgets it and a second instance keeps its own
 * count. That errs towards one email too many, never towards losing one a
 * person asked for — the right direction for every caller here.
 */
export class SendBudget {
  private readonly sentAt = new Map<string, number[]>();

  constructor(
    private readonly perHour: number,
    private readonly minGapMs = 0,
  ) {}

  /** Whether `address` may be mailed now. Asking does not spend — `record` does. */
  allows(address: string, now = Date.now()): boolean {
    const recent = this.recent(keyOf(address), now);
    if (recent.length >= this.perHour) return false;
    const last = recent.at(-1);
    return last === undefined || now - last >= this.minGapMs;
  }

  record(address: string, now = Date.now()): void {
    const key = keyOf(address);
    this.sentAt.set(key, [...this.recent(key, now), now]);
    // Swept on write: bounded by activity, no timer.
    if (this.sentAt.size > 1_000) {
      for (const k of this.sentAt.keys()) {
        if (this.recent(k, now).length === 0) this.sentAt.delete(k);
      }
    }
  }

  private recent(key: string, now: number): number[] {
    const cutoff = now - HOUR_MS;
    return (this.sentAt.get(key) ?? []).filter((at) => at > cutoff);
  }
}

const HOUR_MS = 60 * 60_000;

function keyOf(address: string): string {
  return address.trim().toLowerCase();
}
