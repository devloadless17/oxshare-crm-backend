import { Inject, Injectable, Logger } from '@nestjs/common';
import { and, eq, inArray, isNotNull, isNull, notInArray, sql } from 'drizzle-orm';
import { DRIZZLE_DB } from '../../../database/database.module';
import type { Db } from '../../../database/db';
import {
  mt5Groups,
  tradingAccounts,
  tradingProductGroups,
  tradingProducts,
} from '../../../database/schema';
import type { Mt5GroupDto } from './dto/mt5-group.dto';
import { territoryCounts, type ClientScope } from '../../../common/security/client-scope';
import { Mt5BridgeClient, type Mt5Group } from './mt5-bridge.client';
import { amountFrom, commissionsFrom, stopOutModeFrom } from '../../../common/mt5-group-terms';

/** One group as the mirror holds it, plus how fresh that record is. */
export interface CachedGroup {
  name: string;
  currency: string;
  leverageDefault: number | null;
  /** The last sync that saw it on the server. */
  lastSeenAt: Date;
  /** Set when the server stopped reporting it. */
  removedAt: Date | null;
}

/** What one sync run found. */
export interface GroupSyncRun {
  /** Groups the server reported. */
  onServer: number;
  /** Rows this run created — groups nobody had seen before. */
  added: number;
  /** Groups that stopped being reported and were marked gone this run. */
  removed: number;
  /** Groups that were marked gone and came back. */
  restored: number;
  /** Claimed groups whose currency on the server no longer matches ours. */
  currencyDrift: number;
  /** Claimed groups the server no longer reports at all. */
  claimedMissing: number;
}

/**
 * Keeps a written-down copy of the MT5 group catalogue, and notices when it
 * changes.
 *
 * ## Why a mirror at all, when `GET /groups` already answers
 *
 * Because a live call answers exactly one question — what is true right now —
 * and the two questions that actually matter are different ones.
 *
 * **"What can you show me when MT5 is down?"** Every group picker was a live
 * round trip costing ~4.9s by `mt5-bridge.client.ts`'s own measurement, so an
 * unreachable bridge turned a settings screen into an error page. A list marked
 * stale is worth more than no list, and an operator can tell the difference.
 *
 * **"What changed?"** This is the one a live read structurally cannot answer.
 * A group renamed, deleted, or repriced into another currency underneath a
 * product that is still selling it looks completely normal to a call that only
 * ever sees the present — the group is simply absent, exactly as if it had
 * never existed. The consequence is not abstract: `trading_product_groups`
 * caches a currency at attach time and every new account opens into a group
 * path stored months earlier, so a group that moved leaves the CRM opening
 * accounts into somewhere that no longer exists, or labelling balances in a
 * currency the server disagrees with. Noticing requires having written down
 * what was there before, which is this table.
 *
 * ## The server is still the authority
 *
 * Nothing here decides anything. `attachGroup` deliberately keeps its LIVE
 * check — it is an operator action performed a handful of times a year, and
 * validating a permanent decision against a cache would be trading the one
 * guarantee that screen exists to provide for latency nobody asked to save.
 * This mirror is read when the live call is unavailable, and compared against
 * when it is not.
 */
@Injectable()
export class Mt5GroupSyncService {
  private readonly logger = new Logger(Mt5GroupSyncService.name);

  /**
   * Which of these group names the CRM has never synced — the trigger for an
   * instant group sync (7 Oct 2026). One indexed read per snapshot batch.
   */
  async unknownGroups(names: string[]): Promise<string[]> {
    const wanted = [...new Set(names.filter((name) => name.length > 0))];
    if (wanted.length === 0) return [];
    const known = await this.db
      .select({ name: mt5Groups.name })
      .from(mt5Groups)
      .where(inArray(mt5Groups.name, wanted));
    const have = new Set(known.map((row) => row.name));
    return wanted.filter((name) => !have.has(name));
  }

  constructor(
    @Inject(DRIZZLE_DB) private readonly db: Db,
    private readonly bridge: Mt5BridgeClient,
  ) {}

  /**
   * Re-read the catalogue and reconcile the mirror against it.
   *
   * Returns null when the bridge is not configured on this deployment — a
   * legitimate state (the CRM runs without MT5 in development), and distinct
   * from a sync that ran and found nothing.
   *
   * ## An EMPTY response is not treated as "every group was deleted"
   *
   * A manager account whose permissions were changed reports zero groups, and
   * so does a bridge answering from a half-initialised session. Both are far
   * more likely than a broker deleting their entire group structure, and the
   * damage is asymmetric: marking every group removed would flag every product
   * on the platform as broken and, once `availableGroups` starts falling back
   * to this table, leave the operator with an empty picker and no way to tell
   * why. So an empty catalogue is refused as implausible and the previous
   * mirror stands.
   */
  async sync(): Promise<GroupSyncRun | null> {
    if (!this.bridge.isConfigured) return null;

    const onServer = await this.bridge.listGroups();

    if (onServer.length === 0) {
      this.logger.warn(
        'MT5 reported ZERO trading groups. Refusing to mark the whole catalogue removed — the ' +
          "overwhelmingly likely cause is this manager account's group permissions, not the " +
          'broker deleting every group. The previous catalogue stands.',
      );
      return {
        onServer: 0,
        added: 0,
        removed: 0,
        restored: 0,
        currencyDrift: 0,
        claimedMissing: 0,
      };
    }

    const before = await this.db.select().from(mt5Groups);
    const knownBy = new Map(before.map((row) => [row.name.toLowerCase(), row]));

    let added = 0;
    let restored = 0;

    for (const group of onServer) {
      /*
       * INSERT-then-UPDATE rather than a read followed by a branch on it.
       *
       * The snapshot above is a moment old, and this job is a `@Cron` that runs
       * on every instance. Two of them starting the same hour both read "no such
       * group" and both insert, and the loser takes a unique violation that
       * aborts the whole run — turning a harmless duplicate into an hour with no
       * sync at all. `ON CONFLICT DO NOTHING` makes the race a no-op and the
       * update below then applies either way.
       */
      const inserted = await this.db
        .insert(mt5Groups)
        .values({
          name: group.name,
          currency: group.currency,
          leverageDefault: this.leverageOf(group),
          ...this.termsOf(group),
        })
        .onConflictDoNothing()
        .returning({ id: mt5Groups.id });

      if (inserted.length > 0) {
        added += 1;
        continue;
      }

      if (knownBy.get(group.name.toLowerCase())?.removedAt) restored += 1;

      await this.db
        .update(mt5Groups)
        .set({
          /*
           * The SERVER's spelling wins on every run, including its casing. The
           * name is matched case-insensitively — MT5 treats it that way — so a
           * broker who re-cases a group would otherwise leave us storing the old
           * form and handing it back to MT5 on every account open.
           */
          name: group.name,
          currency: group.currency,
          leverageDefault: this.leverageOf(group),
          ...this.termsOf(group),
          lastSeenAt: new Date(),
          removedAt: null,
        })
        /*
         * Matched on the NAME rather than on the id from the snapshot, because
         * the row may have been created by the instance that won the insert
         * race and its id was never in this run's snapshot.
         */
        .where(sql`lower(${mt5Groups.name}) = ${group.name.toLowerCase()}`);
    }

    const present = onServer.map((group) => group.name.toLowerCase());

    /*
     * Everything the mirror still calls live that this run did not see.
     *
     * Marked in ONE statement rather than per row, so a group cannot be marked
     * removed by this run and restored by a concurrent one in between. The
     * `removedAt IS NULL` guard is what makes it idempotent: a group already
     * marked keeps its ORIGINAL removal timestamp, which is the one that
     * answers "how long has this been gone".
     */
    const removedRows = await this.db
      .update(mt5Groups)
      .set({ removedAt: new Date() })
      .where(and(isNull(mt5Groups.removedAt), notInArray(sql`lower(${mt5Groups.name})`, present)))
      .returning({ name: mt5Groups.name });

    for (const row of removedRows) {
      this.logger.warn(`MT5 no longer reports the group "${row.name}".`);
    }

    const drift = await this.checkClaimedGroups(onServer);

    return {
      onServer: onServer.length,
      added,
      removed: removedRows.length,
      restored,
      ...drift,
    };
  }

  /**
   * The groups the server currently reports, with the product that sells each
   * and how many accounts the CRM holds in it. The MT5 Groups screen.
   *
   * Groups the server stopped reporting are LEFT OUT (25 Sep 2026, the owner's
   * call): the screen lists what MT5 holds today. They stay in the mirror —
   * `removed_at` is what lets a group that comes back be restored rather than
   * duplicated — they are just not shown.
   *
   * THREE plain queries merged in memory rather than one with correlated
   * subqueries. Groups number in the dozens, and Drizzle renders a column
   * inside a select-list `sql` template as a bare name, which inside a
   * subquery silently binds to the inner table (the bug that made every IB
   * rung report the whole platform's partner count). Plain selects cannot make
   * that mistake.
   *
   * Matched CASE-INSENSITIVELY on the group path, like every other lookup of a
   * group here: MT5 treats `real\Standard` and `Real\standard` as one group,
   * and the mirror's unique index is on `lower(name)`.
   *
   * The account count is split by the READER's territory (D-81 R2):
   * `accountCount` is the accounts they may see, `accountsOutsideScope` the
   * rest — counted, never named. A trading account belongs to its client.
   */
  async listForAdmin(scope: ClientScope): Promise<Mt5GroupDto[]> {
    const split = territoryCounts(scope, tradingAccounts.userId);
    const [groups, claims, counts] = await Promise.all([
      this.db
        .select({
          name: mt5Groups.name,
          currency: mt5Groups.currency,
          leverageDefault: mt5Groups.leverageDefault,
          commissions: mt5Groups.commissions,
          marginCall: mt5Groups.marginCall,
          marginStopOut: mt5Groups.marginStopOut,
          marginStopOutMode: mt5Groups.marginStopOutMode,
        })
        .from(mt5Groups)
        .where(isNull(mt5Groups.removedAt))
        .orderBy(mt5Groups.name),
      this.db
        .select({
          mt5Group: tradingProductGroups.mt5Group,
          environment: tradingProductGroups.environment,
          productId: tradingProducts.id,
          productName: tradingProducts.name,
        })
        .from(tradingProductGroups)
        .innerJoin(tradingProducts, eq(tradingProducts.id, tradingProductGroups.productId)),
      this.db
        .select({
          group: sql<string>`lower(${tradingAccounts.mt5Group})`,
          inScope: split.inScope,
          outside: split.outside,
        })
        .from(tradingAccounts)
        .where(isNotNull(tradingAccounts.mt5Group))
        .groupBy(sql`lower(${tradingAccounts.mt5Group})`),
    ]);

    /* Several products may sell one group (0142), so each group maps to a list. */
    const soldBy = new Map<string, Mt5GroupDto['products']>();
    for (const claim of claims) {
      const key = claim.mt5Group.toLowerCase();
      const list = soldBy.get(key) ?? [];
      list.push({ id: claim.productId, name: claim.productName, environment: claim.environment });
      soldBy.set(key, list);
    }
    const accountsIn = new Map(counts.map((row) => [row.group, row]));

    return groups.map((group) => {
      const key = group.name.toLowerCase();
      return {
        ...group,
        products: (soldBy.get(key) ?? []).sort((a, b) => a.name.localeCompare(b.name)),
        accountCount: accountsIn.get(key)?.inScope ?? 0,
        accountsOutsideScope: accountsIn.get(key)?.outside ?? 0,
      };
    });
  }

  /**
   * The mirror, for a caller that cannot reach the bridge.
   *
   * Vanished groups are excluded by default: a picker offering a group the
   * server does not have would produce an account-open failure with an MT5
   * return code naming neither the field nor the reason, which is the exact
   * outcome the products screen exists to prevent.
   */
  async cached(options: { includeRemoved?: boolean } = {}): Promise<CachedGroup[]> {
    const rows = await this.db
      .select({
        name: mt5Groups.name,
        currency: mt5Groups.currency,
        leverageDefault: mt5Groups.leverageDefault,
        lastSeenAt: mt5Groups.lastSeenAt,
        removedAt: mt5Groups.removedAt,
      })
      .from(mt5Groups)
      .where(options.includeRemoved ? undefined : isNull(mt5Groups.removedAt))
      .orderBy(mt5Groups.name);

    return rows;
  }

  /**
   * The group list a picker should show: live if the bridge answers, the mirror
   * if it does not.
   *
   * ## The fallback is the whole reason the mirror is written down
   *
   * Before this, every picker was a bare `GET /groups` and an unreachable MT5
   * meant an error page — on a settings screen whose job is to let an operator
   * see what the broker offers. Falling back does not make the answer less true;
   * it makes it OLDER, and `lastSeenAt` is returned so the caller can say which
   * it got rather than presenting a month-old list as current.
   *
   * ## Attaching a group still asks the server directly
   *
   * This is for LOOKING. `CatalogueService.attachGroup` deliberately keeps its
   * own live check, because writing down a permanent product↔group decision
   * against a cache would trade away the single guarantee that screen exists to
   * provide — that the group is really there — to save a round trip on an action
   * performed a handful of times a year.
   */
  async offerable(): Promise<{
    live: boolean;
    groups: Array<{ name: string; currency: string; lastSeenAt: Date | null }>;
  }> {
    if (this.bridge.isConfigured) {
      try {
        const onServer = await this.bridge.listGroups();
        return {
          live: true,
          groups: onServer.map((group) => ({
            name: group.name,
            currency: group.currency,
            lastSeenAt: null,
          })),
        };
      } catch (error) {
        this.logger.warn(
          'MT5 did not answer with its group list; falling back to the last synced catalogue. ' +
            `${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }

    const cached = await this.cached();
    return {
      live: false,
      groups: cached.map((group) => ({
        name: group.name,
        currency: group.currency,
        lastSeenAt: group.lastSeenAt,
      })),
    };
  }

  /**
   * Compare what products are SELLING against what the server actually offers.
   *
   * This is the payoff for keeping the mirror, and the reason the sync is worth
   * running at all. Both findings below are silent in production today: a
   * client hits them at account-open time, as an MT5 error code, and the desk
   * hears about it as "I can't open an account".
   */
  private async checkClaimedGroups(
    onServer: Mt5Group[],
  ): Promise<{ currencyDrift: number; claimedMissing: number }> {
    const claimed = await this.db
      .select({
        mt5Group: tradingProductGroups.mt5Group,
        currency: tradingProductGroups.currency,
      })
      .from(tradingProductGroups);

    const serverBy = new Map(onServer.map((group) => [group.name.toLowerCase(), group]));

    let currencyDrift = 0;
    let claimedMissing = 0;

    for (const row of claimed) {
      const live = serverBy.get(row.mt5Group.toLowerCase());

      if (!live) {
        claimedMissing += 1;
        this.logger.error(
          `A product is still selling the MT5 group "${row.mt5Group}", which the server no longer ` +
            'reports. Every new account opened under that product will fail at MT5, and the ' +
            'error names neither the group nor the reason. Re-point the product at a live group.',
        );
        continue;
      }

      if (live.currency.toLowerCase() !== row.currency.toLowerCase()) {
        currencyDrift += 1;
        this.logger.error(
          `The MT5 group "${row.mt5Group}" is denominated in ${live.currency} on the server, but ` +
            `the product selling it has ${row.currency} cached from when it was attached. Every ` +
            'balance shown for those accounts is labelled with the wrong currency until this is ' +
            're-attached.',
        );
      }
    }

    return { currencyDrift, claimedMissing };
  }

  /**
   * MT5 reports a group's default leverage only as `DemoLeverage`, and uses 0
   * to mean "unset". Stored as NULL so an unset group is distinguishable from
   * one somebody deliberately configured — 1:0 is not a leverage.
   */
  private leverageOf(group: Mt5Group): number | null {
    return group.leverageDefault > 0 ? group.leverageDefault : null;
  }

  /**
   * MT5's own commission rules and margin levels on the group (0144), as the
   * columns to write — or NOTHING when the bridge did not report them.
   *
   * An older bridge sends none of these fields. Writing nulls then would erase
   * what a newer bridge recorded the day before, and "not reported" would
   * overwrite a real answer. So an unreported group keeps what is stored, and
   * the four fields move together: they come from the same MT5 answer.
   */
  private termsOf(group: Mt5Group) {
    const commissions = commissionsFrom(group.commissions);
    if (commissions === null) return {};
    return {
      commissions,
      marginCall: amountFrom(group.marginCall),
      marginStopOut: amountFrom(group.marginStopOut),
      marginStopOutMode: stopOutModeFrom(group.marginStopOutMode),
    };
  }
}
