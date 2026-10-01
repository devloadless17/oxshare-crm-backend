import { Inject, Injectable } from '@nestjs/common';
import { eq, sql } from 'drizzle-orm';
import { DRIZZLE_DB } from '../database/database.module';
import type { Db, Executor } from '../database/db';
import { offeredCountries } from '../database/schema';
import { offeredLists, type OfferedLists } from '../common/kyc/country-options';

/**
 * THE ONE SOURCE OF COUNTRIES (0178) — what sign-up, KYC, the desk's edit and
 * the payment-method rules all offer. A single tiny row; read on demand, never
 * cached, so every instance sees an admin's save at once.
 */
@Injectable()
export class OfferedCountriesStore {
  constructor(@Inject(DRIZZLE_DB) private readonly db: Db) {}

  async get(executor: Executor = this.db): Promise<OfferedLists> {
    const [row] = await executor
      .select({ codes: offeredCountries.codes })
      .from(offeredCountries)
      .where(eq(offeredCountries.id, true))
      .limit(1);
    return offeredLists(row?.codes ?? null);
  }

  /** Replace the list (codes already checked by the caller), in the caller's transaction. */
  async set(codes: readonly string[], updatedBy: string, executor: Executor): Promise<void> {
    await executor
      .insert(offeredCountries)
      .values({ id: true, codes: [...codes], updatedBy, updatedAt: sql`now()` })
      .onConflictDoUpdate({
        target: offeredCountries.id,
        set: { codes: [...codes], updatedBy, updatedAt: sql`now()` },
      });
  }
}
