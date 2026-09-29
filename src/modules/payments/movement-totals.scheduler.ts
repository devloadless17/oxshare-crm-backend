import { Inject, Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { sql } from 'drizzle-orm';
import { DRIZZLE_DB } from '../../database/database.module';
import type { Db } from '../../database/db';

/**
 * Folds the money-movement deltas into the daily and per-client totals
 * (migration 0165).
 *
 * Every money write appends a delta row from a trigger — never an update of a
 * shared counter, which would serialise every deposit of the day and could
 * deadlock against the wallet locks. Reads sum the totals AND the deltas, so they
 * are exact whether or not this has run; folding only keeps the deltas table
 * small, so a read stays the size of the totals however much money has moved.
 *
 * No lease: `fold_movement_totals()` takes an advisory lock and moves the rows it
 * deletes in ONE statement, so two instances folding at once run one after the
 * other and cannot count a delta twice. Never throws: a missed fold costs a
 * slightly larger read a minute later, nothing more.
 */
@Injectable()
export class MovementTotalsScheduler {
  private readonly logger = new Logger(MovementTotalsScheduler.name);

  constructor(@Inject(DRIZZLE_DB) private readonly db: Db) {}

  @Cron(CronExpression.EVERY_MINUTE, { name: 'payments.foldMovementTotals' })
  async fold(): Promise<number> {
    try {
      const { rows } = await this.db.execute<{ folded: number }>(
        sql`SELECT fold_movement_totals() AS folded`,
      );
      return rows[0]?.folded ?? 0;
    } catch (error) {
      this.logger.warn(
        `Folding the movement totals failed; reads stay exact, only larger: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      return 0;
    }
  }
}
