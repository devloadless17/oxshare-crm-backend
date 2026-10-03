/**
 * The history and balance-movement WINDOWS, and the account statistics shape,
 * split out of `trading.service.ts` (a 1300-line class mixing listing, live
 * reads, history and these pure helpers). Pure: no Nest, no database.
 */
import { ValidationError } from '../../common/errors/domain-errors';
import type { AccountHistoryQueryDto, AccountStatsDto } from './dto/account-detail.dto';
/** One money movement on an MT5 account with no position behind it. */
export interface BalanceMovementRow {
  ticket: string;
  accountId: string;
  login: string;
  action: number;
  actionLabel: string;
  amount: string;
  comment: string | null;
  dealtAt: Date;
}

/** MT5's numeric position side, named. An unknown code is reported raw. */
/**
 * The window to read, with defaults and the ceiling applied.
 *
 * ## Thirty days by default, thirty-one at most
 *
 * The ceiling OUTLIVED its original reason and is kept on a new one, which is
 * worth stating rather than leaving as folklore.
 *
 * It was here because MT5 silently TRUNCATES a request for a larger range rather
 * than refusing it, so a client asking for a year would be shown a partial
 * history that looked complete. Reading from `mt5_deals` retires that: Postgres
 * returns every row in the range or none.
 *
 * What is left is the size of the ANSWER. Every deal in the window is
 * serialised to the client and summed in Node, and an active account can trade
 * hundreds a day — so the bound is now on the response and on the statistics
 * loop, not on a quirk of the trading server. Thirty-one days is what the portal
 * offers and comfortably more than it asks for.
 *
 * Raising it is now a real option in a way it never was before, and the shape it
 * needs is a PAGED deal list with the statistics aggregated in SQL. It is not a
 * matter of moving this constant: the whole window currently lands in one array
 * because that is what makes the totals and the list provably describe the same
 * rows.
 *
 * ## Inclusive at both ends, by DATE PART
 *
 * `to` becomes the END of its day. Parsing it as midnight excludes almost the
 * whole final day — the "my newest row vanished when I set an end date" bug that
 * `date-range.ts` and `TransactionsService` both carry a note about.
 */
export function resolveWindow(query: AccountHistoryQueryDto): { from: Date; to: Date } {
  const to = query.to ? endOfDay(query.to) : endOfDay(todayIso());
  const from = query.from ? startOfDay(query.from) : new Date(to.getTime() - THIRTY_DAYS_MS);

  if (from.getTime() > to.getTime()) {
    throw new ValidationError('The start of the range must not be after its end.');
  }

  if (to.getTime() - from.getTime() > MAX_WINDOW_MS) {
    throw new ValidationError(
      'A history window may cover at most 31 days. Ask for a shorter range — a wider one is ' +
        'returned whole or not at all, and a whole one is more than a single response can carry ' +
        'for an actively traded account.',
    );
  }

  return { from, to };
}

const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;
/** 31 whole days, plus the part-day the inclusive end adds. */
const MAX_WINDOW_MS = 32 * 24 * 60 * 60 * 1000;

/** The most balance movements one response carries. See `balanceMovementsMine`. */
export const MOVEMENT_LIMIT = 500;

/**
 * The window for BALANCE MOVEMENTS — the same shape as `resolveWindow`, and
 * deliberately WITHOUT its 31-day cap.
 *
 * Sharing the semantics is the point: `startOfDay` / `endOfDay`, closed at both
 * ends, so a client asking for "the 10th" gets their own 10th on this list
 * exactly as they do on the account history. Two money lists in one product
 * that mean different things by "from" is a divergence noticed at the worst
 * possible moment.
 *
 * ⚠️ But the CAP does not transfer, and copying it because it sits next to the
 * semantics would have been the mistake. Its own message argues from trade
 * volume — *"a whole one is more than a single response can carry for an
 * actively traded account"* — and this list EXCLUDES trades. Dealer
 * adjustments are rare by nature: a client asking for a year of them might get
 * three rows, and a 31-day cap would make them ask twelve times to find that
 * out.
 *
 * What genuinely cannot be returned whole is a large number of ROWS, so that is
 * what `MOVEMENT_LIMIT` bounds — the thing that is actually unbounded rather
 * than a proxy for it. Raised by `crm-92` reviewing the design.
 */
export function resolveMovementWindow(query: AccountHistoryQueryDto): { from: Date; to: Date } {
  const to = query.to ? endOfDay(query.to) : endOfDay(todayIso());
  const from = query.from ? startOfDay(query.from) : new Date(to.getTime() - THIRTY_DAYS_MS);

  if (from.getTime() > to.getTime()) {
    throw new ValidationError('The start of the range must not be after its end.');
  }

  return { from, to };
}

/**
 * `YYYY-MM-DD` to a LOCAL day boundary.
 *
 * Local constructor rather than `new Date('2026-08-01')`, which parses as UTC
 * and so starts the window in the wrong place for every zone but one — the trap
 * the portal's `todayIso()` documents from the other direction.
 */
function startOfDay(iso: string): Date {
  const [year, month, day] = iso.split('-').map(Number);
  return new Date(year, month - 1, day, 0, 0, 0, 0);
}

function endOfDay(iso: string): Date {
  const [year, month, day] = iso.split('-').map(Number);
  return new Date(year, month - 1, day, 23, 59, 59, 999);
}

function todayIso(): string {
  const now = new Date();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  return `${now.getFullYear()}-${month}-${day}`;
}

/**
 * The statistics DTO, assembled from what Postgres already computed.
 *
 * ## Why this is not `computeStats` any more
 *
 * That function summed a decimal.js accumulator across the deals array, which
 * was correct precisely while the array WAS the window. Paging broke that: the
 * array is now one page, and totals derived from it would describe whichever
 * rows the client happened to be looking at.
 *
 * So the arithmetic moved into the query and this became a mapper. It does no
 * maths — every figure arrives from Postgres as a NUMERIC decimal string and is
 * passed through untouched (§6.1), which is the same guarantee the decimal.js
 * version gave and the reason neither ever used a float.
 *
 * `null` totals are impossible for the sums (`coalesce` floors them at 0) and
 * expected for `bestTrade`/`worstTrade`, where `MAX`/`MIN` over no rows is NULL
 * — which is the answer the DTO wants there.
 */
/** A nullable aggregate timestamp, as the `Date` the DTO promises. */
function toDate(value: string | null | undefined): Date | null {
  return value ? new Date(value) : null;
}

export function statsFromTotals(
  totals:
    | {
        trades: string;
        wins: string;
        losses: string;
        volume: string;
        netProfit: string;
        grossProfit: string;
        grossLoss: string;
        commission: string;
        swap: string;
        bestTrade: string | null;
        worstTrade: string | null;
      }
    | undefined,
  activity: { firstDealAt: string | null; lastDealAt: string | null } | undefined,
): AccountStatsDto {
  /*
   * An aggregate over an empty table still returns ONE row, so `undefined` here
   * means the query itself returned nothing — which it cannot. Guarded anyway
   * rather than asserted, because the alternative on a money screen is a crash
   * where an empty panel would do.
   */
  if (!totals) return emptyStats();

  return {
    /* COUNTS are the one place a number is right: `count(*)` is a bigint, it
       arrives as a string, and it is a row count rather than an amount. */
    trades: Number(totals.trades),
    wins: Number(totals.wins),
    losses: Number(totals.losses),
    volume: totals.volume,
    netProfit: totals.netProfit,
    grossProfit: totals.grossProfit,
    grossLoss: totals.grossLoss,
    commission: totals.commission,
    swap: totals.swap,
    bestTrade: totals.bestTrade,
    worstTrade: totals.worstTrade,
    /* Back to a `Date`, which is what the DTO declares and what every other
       timestamp leaving this service is. See the aggregate's own note on why
       these arrive as strings in the first place. */
    firstDealAt: toDate(activity?.firstDealAt),
    lastDealAt: toDate(activity?.lastDealAt),
  };
}

/**
 * What an account with no MT5 login did: nothing, and every figure says so.
 *
 * A function rather than a shared constant, because a caller that mutated one
 * field of a shared object would change every future empty response — and that
 * bug reads as a data problem rather than an aliasing one.
 */
export function emptyStats(): AccountStatsDto {
  return {
    trades: 0,
    wins: 0,
    losses: 0,
    volume: '0',
    netProfit: '0',
    grossProfit: '0',
    grossLoss: '0',
    commission: '0',
    swap: '0',
    bestTrade: null,
    worstTrade: null,
    firstDealAt: null,
    lastDealAt: null,
  };
}
