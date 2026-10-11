/**
 * One read, shared by everyone who asks for it at about the same time.
 *
 * For a figure that is the same for every reader of a key and costs a scan to
 * produce — the dashboard's counters. Without it each open dashboard runs its
 * own whole-table count, and 25 administrators at once made every other screen
 * wait behind them (load test, 11 Oct 2026: 2.5 s here, lists 10× slower).
 *
 *  - Callers arriving while a read is in flight wait for THAT read.
 *  - Its answer is then served for `ttlMs`. Keep it to a few seconds: the
 *    figure is a summary, never something a decision or a balance is taken from.
 *  - A failed read is not kept; the next caller tries again.
 *
 * NEVER for money a person acts on, and never for anything whose answer depends
 * on more than the key — the key must carry everything the read is scoped by.
 */
export class SharedRead<T> {
  private readonly entries = new Map<string, { at: number; value: Promise<T> }>();

  constructor(
    private readonly ttlMs: number,
    private readonly maxEntries = 500,
  ) {}

  get(key: string, load: () => Promise<T>): Promise<T> {
    const now = Date.now();
    const held = this.entries.get(key);
    if (held && now - held.at < this.ttlMs) return held.value;

    const value = load();
    this.entries.set(key, { at: now, value });
    value.catch(() => {
      if (this.entries.get(key)?.value === value) this.entries.delete(key);
    });
    // Bounded: the oldest key goes first (a Map iterates in insertion order).
    if (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next().value;
      if (oldest !== undefined) this.entries.delete(oldest);
    }
    return value;
  }
}
