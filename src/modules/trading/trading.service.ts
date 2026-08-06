import { Inject, Injectable } from '@nestjs/common';
import { asc, eq } from 'drizzle-orm';
import { DRIZZLE_DB } from '../../database/database.module';
import type { getDb } from '../../database/db';
import { tradingAccounts } from '../../database/schema';

type Db = ReturnType<typeof getDb>;

@Injectable()
export class TradingService {
  constructor(@Inject(DRIZZLE_DB) private readonly db: Db) {}

  /**
   * The MT5 accounts belonging to one client.
   *
   * `userId` is derived from the session by the controller and is NOT a
   * parameter a caller can supply. It is the only thing standing between this
   * endpoint and one client reading another's account list — the same rule
   * `WalletController.myLedger` records, and it applies identically here
   * because this route is authenticated but not permission-gated.
   *
   * Ordered oldest-first so the list is stable across reloads. A client's first
   * account is the one they think of as "my account", and a set that reshuffles
   * because two rows share a timestamp makes people look twice at which login
   * they are about to trade on. `id` breaks the tie for exactly that reason.
   *
   * Live and demo come back TOGETHER, in one list, with `environment` on each
   * row. Splitting them into two endpoints would let a client hold a page where
   * one half is fresh and the other is not, and the caller that wants them
   * grouped can group them — the API's job is to say what is true, once.
   */
  listAccounts(userId: string) {
    return this.db
      .select({
        id: tradingAccounts.id,
        mt5Login: tradingAccounts.mt5Login,
        mt5Group: tradingAccounts.mt5Group,
        environment: tradingAccounts.environment,
        tier: tradingAccounts.tier,
        leverage: tradingAccounts.leverage,
        createdAt: tradingAccounts.createdAt,
      })
      .from(tradingAccounts)
      .where(eq(tradingAccounts.userId, userId))
      .orderBy(asc(tradingAccounts.createdAt), asc(tradingAccounts.id));
  }
}
