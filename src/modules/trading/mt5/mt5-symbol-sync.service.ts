import { Inject, Injectable, Logger } from '@nestjs/common';
import { asc, isNull, max, sql } from 'drizzle-orm';
import { DRIZZLE_DB } from '../../../database/database.module';
import type { Db } from '../../../database/db';
import { mt5Symbols } from '../../../database/schema';
import { Mt5BridgeClient } from './mt5-bridge.client';
import type { Mt5SymbolListDto } from './dto/mt5-symbol.dto';

export interface SymbolSyncRun {
  onServer: number;
  removed: number;
}

/**
 * The CRM's copy of MT5's SYMBOL list with each symbol's folder (0198).
 *
 * Two readers, and why it is a mirror rather than a live read:
 *
 *  - The commission engine asks "which folder is this deal's symbol in?" for
 *    every closing deal on a commission type that excludes folders. That must
 *    not depend on the bridge being up at that instant, or a bridge outage
 *    would stall the payout queue.
 *  - The commission type screen's exclusion picker, which must render when the
 *    server is unreachable, dated.
 *
 * Synced with the MT5 groups (same scheduled job), and on demand from the
 * picker. Like the group sync: an EMPTY answer from the server is refused as
 * implausible and the previous list stands, and a symbol the server stops
 * reporting is marked removed rather than deleted — a deal on it may still be
 * waiting to be priced, and its folder is what decides that.
 */
@Injectable()
export class Mt5SymbolSyncService {
  private readonly logger = new Logger(Mt5SymbolSyncService.name);

  constructor(
    @Inject(DRIZZLE_DB) private readonly db: Db,
    private readonly bridge: Mt5BridgeClient,
  ) {}

  async sync(): Promise<SymbolSyncRun | null> {
    if (!this.bridge.isConfigured) return null;

    const onServer = (await this.bridge.listSymbols()).filter((s) => s.symbol?.trim());
    if (onServer.length === 0) {
      this.logger.warn(
        'MT5 reported ZERO symbols. Refusing to mark the symbol list removed — the likely cause ' +
          'is the manager account’s permissions. The previous list stands.',
      );
      return { onServer: 0, removed: 0 };
    }

    /*
     * One statement for the whole list, through JSON rather than array
     * parameters: Drizzle expands a JS array into a parameter LIST, and a few
     * thousand symbols would be a few thousand placeholders.
     */
    const rows = JSON.stringify(
      onServer.map((s) => ({
        symbol: s.symbol.trim().slice(0, 50),
        path: (s.path ?? '').trim().slice(0, 255),
        description: (s.description ?? '').slice(0, 255),
      })),
    );
    await this.db.execute(sql`
      INSERT INTO mt5_symbols (symbol, path, description)
      SELECT DISTINCT ON (lower(x.symbol)) x.symbol, x.path, x.description
        FROM json_to_recordset(${rows}::json) AS x(symbol text, path text, description text)
      ON CONFLICT ((lower(symbol))) DO UPDATE
        SET symbol = EXCLUDED.symbol,
            path = EXCLUDED.path,
            description = EXCLUDED.description,
            last_seen_at = now(),
            removed_at = NULL
    `);
    const removed = await this.db.execute(sql`
      UPDATE mt5_symbols SET removed_at = now()
       WHERE removed_at IS NULL
         AND lower(symbol) NOT IN (
           SELECT lower(x.symbol) FROM json_to_recordset(${rows}::json) AS x(symbol text)
         )
    `);

    return { onServer: onServer.length, removed: removed.rowCount ?? 0 };
  }

  /** The picker's list: what the server last reported, and when that was. */
  async listForAdmin(): Promise<Mt5SymbolListDto> {
    const [symbols, [synced]] = await Promise.all([
      this.db
        .select({
          symbol: mt5Symbols.symbol,
          path: mt5Symbols.path,
          description: mt5Symbols.description,
        })
        .from(mt5Symbols)
        .where(isNull(mt5Symbols.removedAt))
        .orderBy(asc(mt5Symbols.path), asc(mt5Symbols.symbol)),
      this.db.select({ at: max(mt5Symbols.lastSeenAt) }).from(mt5Symbols),
    ]);
    return { symbols, lastSyncedAt: synced?.at ?? null };
  }
}
