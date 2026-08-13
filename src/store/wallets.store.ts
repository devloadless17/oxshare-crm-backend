import { Inject, Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { DRIZZLE_DB } from '../database/database.module';
import type { Db } from '../database/db';

/**
 * Wallet reads and writes that belong to no single module.
 *
 * ## Why this is a store rather than a method on WalletProvisioningService
 *
 * The backfill below has exactly two callers — `CurrenciesService`, when a
 * currency becomes enabled, and `WalletProvisioningService`, which wraps it in
 * the never-throws contract its siblings hold. Those two cannot reach each
 * other: `WalletModule` imports `CurrenciesModule` (provisioning asks it which
 * currencies are enabled), so a `CurrenciesService` that depended on anything
 * `WalletModule` binds closes the loop.
 *
 * That is not a theoretical objection. Injecting the provisioning PORT into
 * `CurrenciesService` was tried first, on the reasoning that `WalletModule` is
 * `@Global()` so the token is visible without an import. The token is visible;
 * the INSTANTIATION still is not. Nest hung on
 * `createApplicationContext` — no error, no stack, just an unsettled promise and
 * a process that exits when the event loop drains. A cycle that fails loudly is
 * a bad afternoon; this one fails as a hang, which is why the route matters.
 *
 * `StoreModule` is `@Global()` AND is depended upon by modules rather than the
 * reverse, so reaching it from either side adds no edge at all. It is the same
 * route `AuthService` already takes to `IbStore`.
 */
@Injectable()
export class WalletsStore {
  constructor(@Inject(DRIZZLE_DB) private readonly db: Db) {}

  /**
   * Open one currency's wallet for every existing client. Returns the number
   * actually added.
   *
   * ONE statement, not a loop: this runs for a single currency across every
   * user, and a per-user round trip would be hundreds of thousands of them on a
   * real platform, inside an admin request that has already committed.
   *
   * `ON CONFLICT DO NOTHING` is the same idempotence `getOrCreateWallet` relies
   * on, expressed set-wise — it adds exactly the missing rows, takes no locks on
   * wallets that already exist, and NEVER touches an existing balance. A
   * backfill that reset a funded wallet would be the worst bug this file could
   * carry, so the clause is `DO NOTHING` and not `DO UPDATE`.
   *
   * Every user, with no status filter, deliberately: a suspended or unverified
   * client still has a wallet list, and giving them the row now is what stops
   * the gap reappearing the day they are reinstated. The balance is zero and a
   * zero wallet grants nothing.
   *
   * Throws on a bad currency — `wallets.currency` is a foreign key onto
   * `currencies.code`. The callers decide what to do about that; a store that
   * swallowed it would hide a genuine misconfiguration from both of them.
   */
  async openForAllClients(currency: string): Promise<number> {
    const result = await this.db.execute(sql`
      INSERT INTO wallets (user_id, currency)
      SELECT id, ${currency} FROM users
      ON CONFLICT (user_id, currency) DO NOTHING`);

    return result.rowCount ?? 0;
  }
}
