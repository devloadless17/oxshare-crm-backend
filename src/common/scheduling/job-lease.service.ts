import { hostname } from 'os';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { and, eq, lt, sql } from 'drizzle-orm';
import { DRIZZLE_DB } from '../../database/database.module';
import type { Db } from '../../database/db';
import { jobLeases } from '../../database/schema';

/**
 * Runs a scheduled job on ONE instance, whichever gets there first.
 *
 * ## What this is for, and what it is not for
 *
 * It is not a correctness control. Every money job on this platform is
 * idempotent by construction and says so in its own docblock — the accrual is
 * guarded by `ib_accruals_source_earner_uq`, the confirm credit by
 * `ledger_entries_wallet_reference_uq`, a transfer resume by the transfer id
 * being the bridge's own idempotency key. Two instances racing reach one result,
 * and that property must stay true: this class is an optimisation, and an
 * optimisation that becomes load-bearing is a single point of failure nobody
 * designed.
 *
 * What it removes is COST. `@Cron` fires on every instance, so four replicas are
 * four drains of the same queue contending on the same rows for one outcome —
 * and the drain budgets make each run long enough to overlap the next. That is
 * what stops a platform scaling horizontally.
 *
 * ## A missed tick is a NON-EVENT
 *
 * When another instance holds the lease this returns without running, and that
 * is the whole point rather than a degraded mode: the holder is doing the work.
 * Nothing is queued, nothing is retried, and the next tick asks again.
 *
 * ## Fails OPEN, deliberately
 *
 * If the lease table cannot be read the job RUNS anyway. The alternative —
 * every instance skipping because the coordination layer is unavailable — turns
 * a database blip into "no commission was paid today", which is far worse than
 * the duplicate work this exists to avoid. The optimisation may fail; the job
 * may not.
 */
@Injectable()
export class JobLeaseService {
  private readonly logger = new Logger(JobLeaseService.name);

  /**
   * Who this process is, for an operator looking at a lease that has not moved.
   *
   * Host and pid rather than a random id: "which box is stuck" is the first
   * question asked, and a uuid cannot answer it.
   */
  private readonly holder = `${hostname()}#${process.pid}`;

  constructor(@Inject(DRIZZLE_DB) private readonly db: Db) {}

  /**
   * Run `work` if this instance can take the lease; otherwise do nothing.
   *
   * @param name The job's `@Cron` name, so a lease row and a scheduled job are
   * obviously the same thing when read side by side.
   * @param ttlMs How long the lease survives WITHOUT a clean release. This is
   * the crash backstop and must exceed the job's own time budget — set it below
   * and a second instance starts while the first is still working, which is the
   * duplicate run the lease exists to prevent.
   * @returns whether this instance ran the work.
   */
  async run(name: string, ttlMs: number, work: () => Promise<void>): Promise<boolean> {
    if (!(await this.acquire(name, ttlMs))) return false;

    try {
      await work();
      return true;
    } finally {
      /*
       * Released in `finally`, so a job that THREW does not hold its lease until
       * the TTL. The scheduler above logs the failure; holding the lease as well
       * would turn one bad run into a silent outage lasting the whole backstop.
       */
      await this.release(name);
    }
  }

  /**
   * Claim the lease, or report that somebody else holds a live one.
   *
   * One statement, because check-then-write races itself: two instances would
   * both read "expired" and both proceed. `ON CONFLICT … WHERE` makes the
   * database decide, and exactly one `RETURNING` comes back non-empty.
   */
  private async acquire(name: string, ttlMs: number): Promise<boolean> {
    const expiresAt = new Date(Date.now() + ttlMs);

    try {
      const taken = await this.db
        .insert(jobLeases)
        .values({ name, holder: this.holder, expiresAt })
        .onConflictDoUpdate({
          target: jobLeases.name,
          set: { holder: this.holder, acquiredAt: new Date(), expiresAt },
          /*
           * Only when the current lease has EXPIRED. Without this predicate the
           * upsert always wins and the lease means nothing — every instance
           * would take it from every other one on every tick.
           */
          where: lt(jobLeases.expiresAt, new Date()),
        })
        .returning({ name: jobLeases.name });

      return taken.length > 0;
    } catch (error) {
      /*
       * FAIL OPEN — see the class note. A coordination layer that is down must
       * not stop the work; it must only stop being an optimisation.
       */
      this.logger.warn(
        `Could not take the '${name}' lease, so this instance is running it anyway. Another ` +
          'instance may run it too, which every job here tolerates: ' +
          `${error instanceof Error ? error.message : String(error)}`,
      );
      return true;
    }
  }

  /**
   * Hand the lease back by expiring it now.
   *
   * Guarded on `holder`, so a run that overran its TTL and was taken over by
   * another instance cannot release a lease it no longer owns — that would hand
   * a THIRD instance the job while the second is still working.
   */
  private async release(name: string): Promise<void> {
    try {
      await this.db
        .update(jobLeases)
        .set({ expiresAt: sql`now()` })
        .where(and(eq(jobLeases.name, name), eq(jobLeases.holder, this.holder)));
    } catch (error) {
      /*
       * Swallowed. The lease expires on its own, and throwing here would replace
       * a job that SUCCEEDED with a failure whose only cause is bookkeeping.
       */
      this.logger.warn(
        `Could not release the '${name}' lease; it expires on its own: ` +
          `${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
}
