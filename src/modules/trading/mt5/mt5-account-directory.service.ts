import { Inject, Injectable, Logger } from '@nestjs/common';
import { and, eq, isNull, sql } from 'drizzle-orm';
import { DRIZZLE_DB } from '../../../database/database.module';
import type { Db } from '../../../database/db';
import { currencies, tradingAccounts } from '../../../database/schema';
import { ProductsStore } from '../../../store/products.store';
import { Mt5BridgeClient } from './mt5-bridge.client';

/** What one directory sync did. */
export interface DirectorySyncRun {
  /** Logins MT5 reported (every group the bridge watches). */
  onServer: number;
  /** Of those, logins the CRM had no account for before this run. */
  newOnServer: number;
  /** Accounts this run recorded — with no client, ready to assign. */
  added: number;
  /** New logins left for the next run (the per-run budget ran out). */
  remaining: number;
  /** Skipped: MT5 holds them in a currency this platform does not (add it, and the next run takes them). */
  unknownCurrency: string[];
  /** Unassigned accounts MT5 confirmed it no longer has, removed from the CRM. */
  removed: number;
  /** Set when the run stopped early because MT5 kept failing. */
  stoppedEarly?: string;
}

/**
 * EVERY MT5 account in the CRM (owner, 29 Sep 2026).
 *
 * An account opened through the CRM is recorded when it is created. One opened
 * any other way — before the CRM, by another desk, by hand in the manager — was
 * invisible: its deals waited in `mt5_deals` as orphans and paid no partner.
 * This sync lists every login the bridge watches and records each one the CRM
 * does not have in `trading_accounts` with NO client (`user_id` NULL, 0166). The
 * Trading accounts screen shows those as "No client", and assigning one to a
 * client (`linkMt5Account`) makes its waiting trades pay from the next run.
 *
 * ## Why it is paced
 *
 * The LIST is one MT5 call per group, cheap at any book size. Recording an
 * account needs two reads of it (the account, and its holder), each taking the
 * bridge's single MT5 session — so a broker with years of accounts is taken a
 * batch at a time (`MT5_ACCOUNT_SYNC_BATCH`, 200) inside a time budget, and
 * clients waiting on that session are never starved behind a backfill. Once the
 * backlog is in, a run only reads the handful of accounts opened since the last.
 *
 * ## Balances after that
 *
 * Nothing here: an unowned row is an ordinary `trading_accounts` row, so the
 * bridge's balance sweep (which pulls the CRM's logins) keeps it current like
 * any other.
 *
 * ## Removal is confirmed, never inferred
 *
 * A login missing from the list is not proof: one group the manager account
 * cannot read drops out of the listing whole. So an unowned account the list no
 * longer carries is removed only after MT5 answers "no such account" for it.
 * An account with a client is never removed here.
 */
@Injectable()
export class Mt5AccountDirectoryService {
  private readonly logger = new Logger(Mt5AccountDirectoryService.name);

  constructor(
    @Inject(DRIZZLE_DB) private readonly db: Db,
    private readonly bridge: Mt5BridgeClient,
    private readonly products: ProductsStore,
  ) {}

  /** Null when no bridge is configured on this deployment. */
  async sync(
    options: { batch?: number; budgetMs?: number } = {},
  ): Promise<DirectorySyncRun | null> {
    if (!this.bridge.isConfigured) return null;
    const batch = options.batch ?? Number(process.env.MT5_ACCOUNT_SYNC_BATCH ?? 200);
    const deadline = Date.now() + (options.budgetMs ?? 4 * 60_000);

    const logins = await this.bridge.listLogins();
    if (logins.length === 0) {
      // Implausible, and the damage of believing it is asymmetric — see the group sync.
      this.logger.warn(
        'MT5 reported ZERO logins. Nothing was added or removed; the likely cause is the ' +
          "manager account's group permissions, not an empty broker.",
      );
      return {
        onServer: 0,
        newOnServer: 0,
        added: 0,
        remaining: 0,
        unknownCurrency: [],
        removed: 0,
      };
    }
    const listed = JSON.stringify(logins);

    /* The logins the CRM has no row for — one statement, whatever the book size. */
    const fresh = await this.db.execute<{ login: string }>(sql`
      SELECT l.login
        FROM jsonb_array_elements_text(${listed}::jsonb) AS l(login)
       WHERE NOT EXISTS (SELECT 1 FROM trading_accounts t WHERE t.login = l.login)
       ORDER BY length(l.login), l.login
    `);
    const newLogins = fresh.rows.map((row) => row.login);

    const heldCurrencies = new Set(
      (await this.db.select({ code: currencies.code }).from(currencies)).map((row) => row.code),
    );

    const run: DirectorySyncRun = {
      onServer: logins.length,
      newOnServer: newLogins.length,
      added: 0,
      remaining: 0,
      unknownCurrency: [],
      removed: 0,
    };
    const unknown = new Set<string>();
    let failures = 0;
    let read = 0;

    for (const login of newLogins) {
      if (read >= batch || Date.now() > deadline) break;
      read += 1;
      try {
        if (await this.record(login, heldCurrencies, unknown)) run.added += 1;
        failures = 0;
      } catch (error) {
        failures += 1;
        this.logger.warn(
          `Could not record MT5 account ${login}: ` +
            (error instanceof Error ? error.message : String(error)),
        );
        if (failures >= 3) {
          run.stoppedEarly = 'MT5 failed three reads in a row; the next run carries on.';
          break;
        }
      }
    }
    run.remaining = newLogins.length - read;
    run.unknownCurrency = [...unknown].sort();

    if (!run.stoppedEarly && Date.now() < deadline) {
      run.removed = await this.removeGone(listed, deadline);
    }

    if (run.added > 0 || run.removed > 0 || run.remaining > 0) {
      this.logger.log(
        `MT5 accounts synced: ${run.onServer} on the server, ${run.added} recorded with no ` +
          `client, ${run.remaining} still to read, ${run.removed} removed.`,
      );
    }
    if (run.unknownCurrency.length > 0) {
      this.logger.warn(
        `MT5 accounts in ${run.unknownCurrency.join(', ')} were not recorded: this platform ` +
          'holds no such currency. Add it under Currencies and the next sync takes them.',
      );
    }
    return run;
  }

  /** Read one login from MT5 and record it with no client. False when it was not recorded. */
  private async record(login: string, held: Set<string>, unknown: Set<string>): Promise<boolean> {
    // Stamped BEFORE the read: the mirror's rule is the moment MT5 was asked.
    const readAt = new Date();
    const snapshot = await this.bridge.getAccount(login);
    if (!snapshot) return false; // deleted between the list and the read
    if (!held.has(snapshot.currency)) {
      unknown.add(snapshot.currency);
      return false;
    }
    const holder = await this.bridge.getAccountHolder(login).catch(() => null);

    /*
     * The product only when exactly one sells the group — the rule opening an
     * account follows. Several: left for the operator to choose on assigning.
     */
    const sellers = await this.products.productIdsForGroup(snapshot.group);
    const inserted = await this.db
      .insert(tradingAccounts)
      .values({
        userId: null,
        login,
        mt5Group: snapshot.group,
        productId: sellers.length === 1 ? sellers[0] : null,
        environment: (await this.products.environmentForGroup(snapshot.group)) ?? 'live',
        currency: snapshot.currency,
        leverage: snapshot.leverage,
        balance: snapshot.balance,
        credit: snapshot.credit,
        balanceSyncedAt: readAt,
        status: 'active',
        mt5HolderName: holder?.name?.slice(0, 256) || null,
        mt5HolderEmail: holder?.email?.slice(0, 320) || null,
      })
      .onConflictDoNothing()
      .returning({ id: tradingAccounts.id });
    return inserted.length > 0;
  }

  /**
   * Unowned accounts the listing no longer carries, removed once MT5 confirms
   * each is gone. Bounded by the run's deadline; the rest wait for the next run.
   */
  private async removeGone(listed: string, deadline: number): Promise<number> {
    const missing = await this.db.execute<{ id: string; login: string }>(sql`
      SELECT t.id, t.login
        FROM trading_accounts t
       WHERE t.user_id IS NULL
         AND t.login IS NOT NULL
         AND NOT EXISTS (
           SELECT 1 FROM jsonb_array_elements_text(${listed}::jsonb) AS l(login)
            WHERE l.login = t.login
         )
       LIMIT 200
    `);
    let removed = 0;
    for (const row of missing.rows) {
      if (Date.now() > deadline) break;
      try {
        if (await this.bridge.getAccount(row.login)) continue; // still there: the listing missed it
        const gone = await this.db
          .delete(tradingAccounts)
          .where(and(eq(tradingAccounts.id, row.id), isNull(tradingAccounts.userId)))
          .returning({ id: tradingAccounts.id });
        removed += gone.length;
      } catch (error) {
        this.logger.warn(
          `Could not confirm or remove MT5 account ${row.login}: ` +
            (error instanceof Error ? error.message : String(error)),
        );
        break;
      }
    }
    return removed;
  }
}
