/**
 * One read, shared by everyone who asks for it at about the same time.
 *
 * For a figure that is the same for every reader of a key and costs a scan to
 * produce — the dashboard's counters. Without it each open dashboard runs its
 * own whole-table count, and 25 administrators at once made every other screen
 * wait behind them (load test, 11 Oct 2026: 2.5 s here, lists 10× slower).
 *
 *  - Callers arriving while the FIRST read is in flight wait for that read.
 *  - Its answer is fresh for `ttlMs`. Keep it to a few seconds: the figure is a
 *    summary, never something a decision or a balance is taken from.
 *  - Once it is older, the next caller starts ONE refresh and everyone is
 *    answered with the last figure until it lands, so nobody waits on the scan
 *    again (it was 600–900 ms every few seconds under load). A figure is never
 *    served past `maxStaleMs`: beyond that, callers wait for the refresh.
 *  - A failed read is not kept; the next caller tries again.
 *
 * NEVER for money a person acts on, and never for anything whose answer depends
 * on more than the key — the key must carry everything the read is scoped by.
 */
export class SharedRead<T> {
  private readonly entries = new Map<
    string,
    { at: number; value: Promise<T>; refresh?: Promise<T> }
  >();

  constructor(
    private readonly ttlMs: number,
    private readonly maxStaleMs = ttlMs * 6,
    private readonly maxEntries = 500,
  ) {}

  get(key: string, load: () => Promise<T>): Promise<T> {
    const now = Date.now();
    const held = this.entries.get(key);
    if (held) {
      const age = now - held.at;
      if (age < this.ttlMs) return held.value;
      if (age < this.maxStaleMs) {
        held.refresh ??= this.refresh(key, held, load);
        return held.value;
      }
      // Too old to show: wait for the refresh already running, or start one.
      if (held.refresh) return held.refresh;
    }
    return this.first(key, load);
  }

  /** The first read of a key (or one too stale to show): callers wait for it. */
  private first(key: string, load: () => Promise<T>): Promise<T> {
    const value = load();
    this.entries.set(key, { at: Date.now(), value });
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

  /** Replaces a stale figure in the background; a failure keeps the old one for now. */
  private refresh(
    key: string,
    held: { at: number; value: Promise<T>; refresh?: Promise<T> },
    load: () => Promise<T>,
  ): Promise<T> {
    const next = load();
    next.then(
      () => {
        if (this.entries.get(key) === held) this.entries.set(key, { at: Date.now(), value: next });
      },
      () => {
        if (this.entries.get(key) === held) held.refresh = undefined;
      },
    );
    return next;
  }
}
