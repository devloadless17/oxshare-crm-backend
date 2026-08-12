import { Inject, Injectable } from '@nestjs/common';
import Decimal from 'decimal.js';
import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import { DRIZZLE_DB } from '../../database/database.module';
import type { Db } from '../../database/db';
import {
  ibAccounts,
  ibAccruals,
  ibLevels,
  ledgerEntries,
  positions,
  users,
  wallets,
} from '../../database/schema';
import { NotFoundError } from '../../common/errors/domain-errors';
import { CommissionService } from './commission.service';
import type { IbClientPositionDto, IbCommissionRowDto, IbOverviewDto } from './dto/ib-overview.dto';

/**
 * The ledger entry types that represent PARTNER income.
 *
 * `commission` and `rebate` are what an engine would credit; `payout` is what a
 * manual settlement credits. All three are already in `ledgerEntryTypeEnum`, so
 * this reads real rows rather than inventing a parallel accounting surface —
 * and the moment anything starts writing them, these totals become live with no
 * change here.
 *
 * `deposit`, `withdrawal`, `transfer` and `adjustment` are deliberately
 * excluded: a partner's own deposit is not something they earned, and counting
 * it would make the earnings figure a second, wrong, wallet balance.
 */
const EARNING_ENTRY_TYPES = ['commission', 'rebate', 'payout'] as const;

/**
 * The currency partner earnings are reported in.
 *
 * A single currency, stated rather than derived, because there is no FX rate
 * source in this system (the same constraint that makes `TransfersService`
 * refuse a cross-currency move). Summing a USD commission and a USDT one into
 * one total would require a rate nobody here has.
 *
 * WHEN A SECOND EARNING CURRENCY APPEARS: this must become a per-currency
 * breakdown, not a converted total.
 */
const EARNINGS_CURRENCY = 'USD';

/** How far back the "recent" figure looks. */
const RECENT_WINDOW_DAYS = 30;

/**
 * What a partner sees about their own programme.
 *
 * ## The honesty rule this service is built around
 *
 * Every number here is READ, never derived from an assumption. The commission
 * engine was deleted in migration 0028 and has not returned, so there is no
 * accrual table to sum — and rather than compute a plausible figure from
 * referral counts and a rate, this returns the true ledger total (currently
 * zero for everyone) alongside `engineLive: false` so the portal can say WHY it
 * is zero.
 *
 * That distinction is the whole point. "You have earned nothing" and "nothing
 * has been calculated yet" are different sentences, and a partner who is owed
 * money reads the first one as a dispute.
 *
 * ## Separate from `IbApplicationsService` on purpose
 *
 * That service owns applications, approvals and the placement rules — writes,
 * mostly, and every one of them a decision. This one only reads, and only for
 * the partner themselves. Keeping them apart means the client-facing dashboard
 * cannot accidentally acquire a code path that mutates a placement.
 */
@Injectable()
export class IbOverviewService {
  constructor(
    @Inject(DRIZZLE_DB) private readonly db: Db,
    /*
     * Only for `isEngineLive()`. This service reads the LEDGER for the totals —
     * it does not read accruals — because the ledger is what has actually been
     * paid, and an accrual is only a claim until it is confirmed.
     */
    private readonly commissions: CommissionService,
  ) {}

  /**
   * The partner dashboard for one partner.
   *
   * Throws `NotFoundError` when the caller has no partner account. That is the
   * right answer rather than an empty overview: a client who is not a partner
   * has no level, no code and no tree, and returning zeroes for all of it would
   * render as a partner dashboard belonging to somebody who is not a partner.
   * The portal already branches on `GET /ib/status` before it asks for this.
   */
  async overviewFor(userId: string): Promise<IbOverviewDto> {
    const [account] = await this.db
      .select()
      .from(ibAccounts)
      .where(eq(ibAccounts.userId, userId))
      .limit(1);

    if (!account) {
      throw new NotFoundError('You are not a partner, so there is no partner overview to show.');
    }

    /*
     * Four independent reads, issued together.
     *
     * None of them depends on another's result, and they are all cheap indexed
     * lookups — `users_referred_by_idx`, `ib_accounts_parent_idx` and the
     * ledger's wallet index. Awaiting them in sequence would make this screen
     * four round-trips deep for no reason.
     */
    const [level, earnings, referredClients, subPartners] = await Promise.all([
      this.levelFor(account.level),
      this.earningsFor(userId),
      this.referredClientsFor(userId),
      this.subPartnersFor(userId),
    ]);

    return {
      level,
      earnings,
      referredClients,
      subPartners,
      verifiedReferredCount: referredClients.filter((client) => client.verified).length,
    };
  }

  /** The rung this partner stands on, and what it pays. */
  private async levelFor(level: number): Promise<IbOverviewDto['level']> {
    const [row] = await this.db
      .select({
        level: ibLevels.level,
        name: ibLevels.name,
        payoutModel: ibLevels.payoutModel,
        rateValue: ibLevels.rateValue,
        maxDirectPartners: ibLevels.maxDirectPartners,
      })
      .from(ibLevels)
      .where(eq(ibLevels.level, level))
      .limit(1);

    /*
     * Null rather than a throw. `ib_accounts.level` is a foreign key so the rung
     * exists, but a level can be DELETED behind a partner in principle, and a
     * partner dashboard that 500s because the ladder was edited is worse than
     * one that shows everything else and omits the rate.
     */
    return row ?? null;
  }

  /**
   * Lifetime and recent earnings, summed from the ledger.
   *
   * ## Summed in the DATABASE, not in JavaScript
   *
   * `SUM()` over NUMERIC(28,8) is exact in Postgres. Pulling the rows and
   * adding them here would work too — with decimal.js — but it would move an
   * unbounded number of rows across the wire to produce two figures, and
   * "unbounded" is what an append-only ledger is.
   *
   * `COALESCE(..., 0)` because SUM over no rows is NULL, and a null total would
   * reach the DTO as a missing string on a money field.
   *
   * The result is cast to `text` so it arrives as a STRING and stays one (§6.1).
   * Without the cast the driver hands back a JS number for a NUMERIC aggregate,
   * which is precisely the float round-trip the money rules exist to prevent.
   */
  private async earningsFor(userId: string): Promise<IbOverviewDto['earnings']> {
    const since = new Date(Date.now() - RECENT_WINDOW_DAYS * 24 * 60 * 60 * 1000);

    /*
     * Joined through `wallets` rather than filtered on a user column, because
     * `ledger_entries` has no `user_id` — it has `wallet_id`, and the wallet
     * knows its owner. Scoping to ONE currency here is what makes summing the
     * rows legitimate; see EARNINGS_CURRENCY.
     */
    const earningWallets = this.db
      .select({ id: wallets.id })
      .from(wallets)
      .where(and(eq(wallets.userId, userId), eq(wallets.currency, EARNINGS_CURRENCY)));

    /*
     * The totals and the engine check, issued together — neither depends on the
     * other, and the flag is meaningless without the figures it qualifies.
     */
    const [[totals], engineLive] = await Promise.all([
      this.db
        .select({
          lifetime: sql<string>`COALESCE(SUM(${ledgerEntries.amount}), 0)::text`,
          recent: sql<string>`COALESCE(SUM(${ledgerEntries.amount}) FILTER (WHERE ${ledgerEntries.createdAt} >= ${since}), 0)::text`,
        })
        .from(ledgerEntries)
        .where(
          and(
            inArray(ledgerEntries.walletId, earningWallets),
            inArray(ledgerEntries.entryType, [...EARNING_ENTRY_TYPES]),
          ),
        ),
      this.commissions.isEngineLive(),
    ]);

    /*
     * Normalised to 8 decimal places through decimal.js, so the shape matches
     * every other money string this API emits ('0.00000000', not '0'). The
     * portal's `isZeroMoney` exists because a bare '0' broke a string
     * comparison once; emitting the canonical form means it never has to.
     */
    return {
      lifetime: new Decimal(totals?.lifetime ?? '0').toFixed(8),
      last30Days: new Decimal(totals?.recent ?? '0').toFixed(8),
      currency: EARNINGS_CURRENCY,
      /*
       * THE HONESTY FLAG, and it is now a READ rather than a constant.
       *
       * It was hardcoded `false` while no commission engine existed. The engine
       * exists — see `commission.service.ts` — so this asks the question the
       * flag actually means: has this system ever CONFIRMED an accrual?
       *
       * Deliberately not `lifetime !== '0.00000000'`, which is a different and
       * wrong question: that is per-partner, so a brand-new partner on a fully
       * working platform would be told the calculation is not running. And it
       * is deliberately not a build-time constant, which would risk reading
       * `false` while real money was moving.
       */
      engineLive,
    };
  }

  /**
   * The clients this partner introduced, newest first.
   *
   * ## No email, and that is a decision rather than an omission
   *
   * A partner is owed ATTRIBUTION — proof that a client is counted as theirs —
   * not their referrals' contact details. Handing over a list of email
   * addresses turns a commission dashboard into a marketing list for people who
   * never consented to be on one, and it is the sort of thing that is
   * impossible to withdraw once shipped.
   *
   * The name is included because a partner introduced these people and
   * recognising them is the point of the list. `verified` is included because it
   * is the difference between a registration and a client who can actually
   * fund — which is what a partner is really counting.
   */
  private async referredClientsFor(userId: string): Promise<IbOverviewDto['referredClients']> {
    const rows = await this.db
      .select({
        userId: users.id,
        firstName: users.firstName,
        lastName: users.lastName,
        verificationLevel: users.verificationLevel,
        since: users.createdAt,
      })
      .from(users)
      .where(eq(users.referredByIbUserId, userId))
      .orderBy(desc(users.createdAt));

    return rows.map((row) => ({
      userId: row.userId,
      name: displayName(row.firstName, row.lastName),
      verified: (row.verificationLevel ?? 0) >= 1,
      since: row.since,
    }));
  }

  /**
   * Partners directly beneath this one.
   *
   * DIRECT only — one hop, not the whole subtree. That matches how the payout
   * ladder resolves (`ARCHITECTURE`: resolution stops at L2, a single
   * `parent_ib_id`, no closure table and no recursive CTE), so showing a deep
   * tree here would display a structure the payout logic does not honour.
   */
  private async subPartnersFor(userId: string): Promise<IbOverviewDto['subPartners']> {
    const rows = await this.db
      .select({
        userId: ibAccounts.userId,
        level: ibAccounts.level,
        active: ibAccounts.active,
        since: ibAccounts.approvedAt,
        firstName: users.firstName,
        lastName: users.lastName,
      })
      .from(ibAccounts)
      .innerJoin(users, eq(users.id, ibAccounts.userId))
      .where(eq(ibAccounts.parentIbUserId, userId))
      .orderBy(desc(ibAccounts.approvedAt));

    return rows.map((row) => ({
      userId: row.userId,
      name: displayName(row.firstName, row.lastName),
      level: row.level,
      active: row.active,
      since: row.since,
    }));
  }

  /**
   * Every commission this partner has earned, newest first.
   *
   * ## Why the CLAIM is shown and not only the credit
   *
   * The dashboard totals read the LEDGER — money actually paid — so a partner
   * whose accruals are still maturing sees zero there with no way to tell
   * "nothing earned" from "earned, not yet released". This table is the other
   * half: every row with its status, so the two numbers explain each other
   * instead of appearing to contradict each other.
   *
   * Scoped by `ib_user_id`, which the accrual already carries — so it needs no
   * join back through the chain and cannot widen to somebody else's earnings
   * if that chain were ever mis-resolved.
   */
  async commissionsFor(userId: string, limit = 200): Promise<IbCommissionRowDto[]> {
    const rows = await this.db
      .select({
        id: ibAccruals.id,
        firstName: users.firstName,
        lastName: users.lastName,
        source: ibAccruals.sourceType,
        baseAmount: ibAccruals.baseAmount,
        rateValue: ibAccruals.rateValue,
        amount: ibAccruals.amount,
        currency: ibAccruals.currency,
        status: ibAccruals.status,
        depth: ibAccruals.depth,
        createdAt: ibAccruals.createdAt,
        confirmedAt: ibAccruals.confirmedAt,
      })
      .from(ibAccruals)
      .innerJoin(users, eq(users.id, ibAccruals.clientUserId))
      .where(eq(ibAccruals.ibUserId, userId))
      .orderBy(desc(ibAccruals.createdAt))
      .limit(limit);

    return rows.map(({ firstName, lastName, ...row }) => ({
      ...row,
      clientName: displayName(firstName, lastName),
    }));
  }

  /**
   * The open trades of the clients this partner introduced.
   *
   * DIRECT clients only. A sub-partner's clients are somebody else's book —
   * this partner earns on them through the chain, but "which of MY clients is
   * trading" is the question here, and widening it would hand one partner a
   * view of another's client list.
   *
   * Open positions only: a closed trade is history, and it already appears in
   * the commission table as the thing it produced.
   */
  async clientPositionsFor(userId: string, limit = 200): Promise<IbClientPositionDto[]> {
    const clients = await this.db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.referredByIbUserId, userId));

    if (clients.length === 0) return [];

    const rows = await this.db
      .select({
        id: positions.id,
        firstName: users.firstName,
        lastName: users.lastName,
        symbol: positions.symbol,
        side: positions.side,
        volume: positions.volume,
        openPrice: positions.openPrice,
        profit: positions.profit,
        openedAt: positions.openedAt,
      })
      .from(positions)
      .innerJoin(users, eq(users.id, positions.userId))
      .where(
        and(
          inArray(
            positions.userId,
            clients.map((client) => client.id),
          ),
          eq(positions.status, 'open'),
        ),
      )
      .orderBy(desc(positions.openedAt))
      .limit(limit);

    return rows.map(({ firstName, lastName, ...row }) => ({
      ...row,
      clientName: displayName(firstName, lastName),
    }));
  }
}

/**
 * A name to show, never an empty string.
 *
 * Both columns are nullable, and a blank cell in a list of people reads as a
 * broken row rather than as missing data. The em dash says "not recorded",
 * which is what it is.
 */
function displayName(firstName: string | null, lastName: string | null): string {
  const name = [firstName, lastName].filter(Boolean).join(' ').trim();
  return name.length > 0 ? name : '—';
}
