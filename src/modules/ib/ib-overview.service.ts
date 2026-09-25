import { Inject, Injectable } from '@nestjs/common';
import Decimal from 'decimal.js';
import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import { DRIZZLE_DB } from '../../database/database.module';
import type { Db } from '../../database/db';
import { ibAccounts, ibAccruals, ledgerEntries, users, wallets } from '../../database/schema';
import { NotFoundError } from '../../common/errors/domain-errors';
import { CommissionService } from './commission.service';

/**
 * The most referred clients one overview response carries.
 *
 * A BOUND on the response, not a page size a caller chooses — this endpoint
 * assembles a dashboard rather than serving a list, and the counts beside the
 * list are what a partner actually reads. Two hundred matches
 * `GET /ib/commissions`, which has been capped at the same number since it was
 * written, for the same reason: a successful partner's history is unbounded and
 * a screen that renders all of it gets slower as they succeed.
 *
 * If a partner ever needs to page their whole roster, that is a dedicated
 * endpoint with a cursor — not a bigger number here.
 */
const REFERRED_CLIENT_PAGE = 200;

/** The same bound on the sub-partner roster, for the same reason. */
const SUB_PARTNER_PAGE = 200;
import { IbWalletService } from './ib-wallet.service';
import type { IbCommissionRowDto, IbOverviewDto } from './dto/ib-overview.dto';

/**
 * The ledger entry types that represent PARTNER income.
 *
 * `commission` is what the confirm loop credits; `payout` is what a manual
 * settlement credits. Both are already in `ledgerEntryTypeEnum`, so this reads
 * real rows rather than inventing a parallel accounting surface.
 *
 * ## `rebate` was here and had to come OUT
 *
 * It was included when a rebate was imagined as a second kind of partner
 * income. Migration 0084 gave the word its FSD meaning instead: a rebate is the
 * TRADING CLIENT's leg, credited to their own main wallet.
 *
 * A partner is also a client — they hold wallets and may themselves have been
 * introduced by somebody else. Leaving `rebate` in this list would have counted
 * the rebates on a partner's OWN trading as commission they had earned from
 * their network, inflating a lifetime-earnings figure they may be paid against.
 *
 * `deposit`, `withdrawal`, `transfer` and `adjustment` are deliberately
 * excluded: a partner's own deposit is not something they earned, and counting
 * it would make the earnings figure a second, wrong, wallet balance.
 */
const EARNING_ENTRY_TYPES = ['commission', 'payout'] as const;

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
/**
 * How many commission entries the partner feed returns.
 *
 * A CAP, and the screen has to say so. The route's own summary read "Every
 * commission this partner has earned" while this returned the newest 200 — the
 * same sentence-versus-behaviour gap `transactions.service.ts` records for the
 * old `LIMIT 100` on the client's money history, where "a client with 150
 * movements was filtering the newest 100 and being told showing 4 of 100".
 *
 * The portal is the half that got this right: `partner-earnings.ts` states that
 * a sum over these rows "is NOT the same claim as everything you have ever
 * earned", and the screen labels the totals as covering the entries listed while
 * putting the LIFETIME figure — summed by the database over the whole ledger —
 * somewhere else entirely. So the product does not mislead anybody; the API
 * description did.
 *
 * Named rather than inline so the number is one thing with one reason, and so
 * `ib-commission-feed.spec.ts` can assert the cap rather than restate it.
 */
export const COMMISSION_FEED_LIMIT = 200;

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
    /*
     * Only for `listCommissionWallets`. Injected rather than reading `wallets`
     * directly here so the "a commission wallet is one with kind = 'commission'"
     * rule lives in ONE place — the moment two services encode it independently
     * is the moment one can be narrowed and the other forgotten, and the failure
     * looks like a partner's balance disappearing.
     *
     * APPENDED LAST: these services are constructed positionally in their specs,
     * so a new parameter in the middle would silently rebind the two above.
     */
    private readonly wallets: IbWalletService,
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
     * FIVE independent reads, issued together.
     *
     * None of them depends on another's result, and they are all cheap indexed
     * lookups — `users_referred_by_idx`, `ib_accounts_parent_idx`,
     * `wallets_user_idx` and the ledger's wallet index. Awaiting them in
     * sequence would make this screen five round-trips deep for no reason.
     *
     * The commission BALANCE joined this list rather than getting its own
     * endpoint, and the reason is the one this whole method is built on: it is
     * read beside the earnings total, and two requests can straddle the hourly
     * confirm loop — leaving a partner looking at a balance their own earnings
     * figure does not account for.
     */
    const [earnings, commissionWallets, referredClients, subPartners, referredCounts] =
      await Promise.all([
        this.earningsFor(userId),
        this.wallets.listCommissionWallets(userId),
        this.referredClientsFor(userId),
        this.subPartnersFor(userId),
        this.referredCountsFor(userId),
      ]);

    return {
      earnings,
      commissionWallets,
      referredClients,
      referredClientCount: referredCounts.total,
      subPartners,
      /*
       * From SQL, not from `referredClients.filter(...).length`. That worked
       * only while the list was complete, and it is capped now — deriving a
       * count from a truncated list reports a partner's own book as smaller
       * than it is.
       */
      verifiedReferredCount: referredCounts.verified,
    };
  }

  /*
   * NOTHING HERE DESCRIBES THE PARTNER'S OWN TERMS, and that is deliberate
   * (0112).
   *
   * `levelFor` went in 0102 and `programme` in 0112 — a rung with its rate,
   * then a named programme with its ladder, each printed at the top of the one
   * screen where a partner looks to understand what they earn. Both were
   * removed on the same instruction: the rate card is a commercial arrangement
   * between the broker and the partner, and the broker publishes it. A CRM
   * screen restating it is a second copy that disagrees the day the desk
   * renegotiates.
   *
   * What this dashboard answers instead is what a partner cannot look up
   * elsewhere: what they have EARNED, who they introduced, and who sits
   * beneath them.
   */

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
    /*
     * ⚠️ NOT filtered by `wallets.kind`, and that is the correct read.
     *
     * Commission now credits the `commission` wallet, but every commission
     * credited BEFORE that change is in the `main` wallet and is just as
     * earned. Narrowing this to the commission wallet would drop every existing
     * partner's lifetime total to zero overnight — a figure they have been
     * reading for months, silently rewritten by a schema change.
     *
     * Spanning both kinds stays right in the other direction too: the transfer
     * between them writes `entry_type = 'transfer'`, which the filter below
     * excludes, so moving money from one to the other cannot double-count it or
     * make the total move at all.
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
      .orderBy(desc(users.createdAt))
      /*
       * CAPPED, where it used to return every referred client.
       *
       * This runs on `GET /ib/overview`, which the partner screen requests every
       * time it opens, and the query had no limit at all — so a partner with
       * fifty thousand referrals transferred fifty thousand rows to render one
       * dashboard. The page got slower exactly as a partner succeeded, which is
       * the one failure a partner programme cannot afford.
       *
       * The same cap and the same reasoning as `GET /ib/commissions`, which has
       * been bounded at 200 since it was written. What makes a capped list safe
       * is that the COUNTS beside it are no longer derived from its length —
       * see `referredCountsFor`.
       */
      .limit(REFERRED_CLIENT_PAGE);

    return rows.map((row) => ({
      userId: row.userId,
      name: displayName(row.firstName, row.lastName),
      verified: (row.verificationLevel ?? 0) >= 1,
      since: row.since,
    }));
  }

  /**
   * How many clients this partner has introduced, and how many are verified.
   *
   * ## Counted in SQL, never from the array above
   *
   * `verifiedReferredCount` used to be `referredClients.filter(...).length`,
   * which was correct only while that list was complete. The moment it is capped
   * that arithmetic under-reports — and it under-reports a partner's own book,
   * silently, in the direction that makes them look less successful than they
   * are.
   *
   * Two counts in one round trip: a partner reads "how many did I introduce" and
   * "how many can actually fund" side by side, and two queries could straddle a
   * verification landing between them.
   */
  private async referredCountsFor(userId: string): Promise<{ total: number; verified: number }> {
    const [row] = await this.db
      .select({
        total: sql<number>`count(*)::int`,
        verified: sql<number>`count(*) filter (where coalesce(${users.verificationLevel}, 0) >= 1)::int`,
      })
      .from(users)
      .where(eq(users.referredByIbUserId, userId));

    return { total: row?.total ?? 0, verified: row?.verified ?? 0 };
  }

  /**
   * Partners directly beneath this one.
   *
   * DIRECT only — one hop, not the whole subtree.
   *
   * That used to match the payout logic exactly, because resolution stopped at
   * L2. It no longer does: 0102 made reach a per-programme decision, so a
   * partner on a three-tier programme is paid through partners this panel does
   * not show.
   *
   * It stays one hop DELIBERATELY, and the reason has changed rather than
   * lapsed. FR-IB-17 gives a parent "visibility of its sub-tree earnings" —
   * earnings, not a roster — and the sub-tree of a partner with a wide network
   * is unbounded, so rendering it whole on a dashboard is a page that gets
   * slower as somebody succeeds. What the partner is owed from the whole tree is
   * in `earnings`, which sums accruals at every depth.
   *
   * NO TERMS on these rows, for the reason nothing on this dashboard carries
   * them (0112): a sub-partner's rate card is between them and the broker, and
   * a parent has no business reading it off their own screen. FR-IB-17 gives a
   * parent visibility of sub-tree EARNINGS, which is what `earnings` carries.
   */
  private async subPartnersFor(userId: string): Promise<IbOverviewDto['subPartners']> {
    const rows = await this.db
      .select({
        userId: ibAccounts.userId,
        active: ibAccounts.active,
        since: ibAccounts.approvedAt,
        firstName: users.firstName,
        lastName: users.lastName,
      })
      .from(ibAccounts)
      .innerJoin(users, eq(users.id, ibAccounts.userId))
      .where(eq(ibAccounts.parentIbUserId, userId))
      .orderBy(desc(ibAccounts.approvedAt))
      /*
       * Capped for the reason the client list above is: this is read on every
       * partner page load, and a successful partner's sub-tree is unbounded.
       * FR-IB-17 gives a parent visibility of its sub-tree EARNINGS, which
       * `earnings` already carries in full — a roster was never the deliverable.
       */
      .limit(SUB_PARTNER_PAGE);

    return rows.map((row) => ({
      userId: row.userId,
      name: displayName(row.firstName, row.lastName),
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
   *
   * ## Commission rows ONLY — never a rebate
   *
   * A rebate row carries the introducing partner in `ib_user_id` because their
   * rung priced it, but the money is the CLIENT's and is paid into the client's
   * own wallet. Listing it here showed it under "Your share" and added it to
   * the partner's totals, so a partner saw every trade twice: once for their
   * commission and once for a rebate that was never theirs. The client sees
   * their rebate in their own wallet statement once it is paid.
   */
  async commissionsFor(
    userId: string,
    limit = COMMISSION_FEED_LIMIT,
  ): Promise<IbCommissionRowDto[]> {
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
      .where(and(eq(ibAccruals.ibUserId, userId), eq(ibAccruals.kind, 'commission')))
      .orderBy(desc(ibAccruals.createdAt))
      .limit(limit);

    return rows.map(({ firstName, lastName, ...row }) => ({
      ...row,
      clientName: displayName(firstName, lastName),
    }));
  }

  /*
   * `clientPositionsFor` IS GONE, with `GET /ib/positions`.
   *
   * It read the `positions` TABLE — created empty on purpose, written by
   * nothing — so it always answered `[]`. See the controller for why reading it
   * live does not scale, and why a partner's EARNINGS are what they are owed.
   */
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
