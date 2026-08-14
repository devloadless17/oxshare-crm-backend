/**
 * What MT5's numeric `action` and `entry` on a deal actually mean.
 *
 * ## Why these are predicates and not an enum
 *
 * `mt5_deals.action` and `.entry` are stored RAW, and the schema comment says
 * why: MT5 adds action values across server builds, and an enum that does not
 * know the newest one turns an unrecognised deal into a failed insert — losing
 * exactly the deal somebody needs to explain.
 *
 * That decision is about INGESTION, and it does not extend to reading. A screen
 * summarising an account has to know which rows are trades and which are money
 * moving in or out, or it reports a client's deposit as a winning trade. So the
 * codes are interpreted HERE, at the read boundary, where an unknown value
 * falls into "not a trade" rather than blocking a write.
 *
 * The lists below are from `IMTDeal::EnDealAction` and `EnEntryFlags` in the
 * Manager API. They are deliberately expressed as "is it one of these" rather
 * than "is it not one of those": a build that adds action 20 must not silently
 * start counting it as a trade, because whatever it is, it is not one we have
 * decided how to summarise.
 */

/** DEAL_BUY. A trade in the market. */
const DEAL_BUY = 0;
/** DEAL_SELL. A trade in the market. */
const DEAL_SELL = 1;

/**
 * DEAL_BUY_CANCELED / DEAL_SELL_CANCELED — a trade the dealer reversed.
 *
 * Deliberately NOT counted as trades. A cancellation and its original are two
 * rows describing one event that did not happen, and counting either inflates
 * the trade count with something the client never had a position from.
 */
const DEAL_BUY_CANCELED = 13;
const DEAL_SELL_CANCELED = 14;

/** ENTRY_IN — opening. Carries no realised profit; the position is still live. */
export const ENTRY_IN = 0;
/** ENTRY_OUT — closing. This is the row that carries the realised result. */
const ENTRY_OUT = 1;
/** ENTRY_INOUT — a reversal: closes one direction and opens the other. */
const ENTRY_INOUT = 2;
/** ENTRY_OUT_BY — closed against an opposing position. Also realises. */
const ENTRY_OUT_BY = 3;

/**
 * Actions that put the client in the market.
 *
 * Everything else — balance, credit, charge, correction, bonus, commission,
 * dividend, tax, agent — is money moving on the account without a position, and
 * is summarised separately by `isBalanceOperation`.
 */
export const TRADE_ACTIONS = [DEAL_BUY, DEAL_SELL] as const;

/**
 * Entries on which a trade's profit becomes REAL.
 *
 * The distinction matters for every figure on the statistics panel. An opening
 * deal carries `profit = 0` because nothing has been realised yet, so counting
 * opens as trades halves the average result and drags the win rate toward zero:
 * every position contributes one guaranteed non-winning row.
 */
export const CLOSING_ENTRIES = [ENTRY_OUT, ENTRY_INOUT, ENTRY_OUT_BY] as const;

/** Was the client in the market on this deal — as opposed to funding? */
export function isTradeAction(action: number): boolean {
  return action === DEAL_BUY || action === DEAL_SELL;
}

/** Did this deal realise a result, or merely open a position? */
export function isClosingEntry(entry: number): boolean {
  return entry === ENTRY_OUT || entry === ENTRY_INOUT || entry === ENTRY_OUT_BY;
}

/** A completed round trip: the row a statistic may count. */
export function isRealisedTrade(deal: { action: number; entry: number }): boolean {
  return isTradeAction(deal.action) && isClosingEntry(deal.entry);
}

/**
 * The reversals, excluded from BOTH summaries.
 *
 * Everything that is not a trade and not one of these is money moving on the
 * account with no position behind it: deposits, withdrawals, credits,
 * corrections, bonuses, commissions, dividends, taxes. On the account screen
 * that set is the account's own transaction history AS MT5 SEES IT — which is
 * not the same list as the CRM's transfers, because a dealer can move an MT5
 * balance directly and the client should see that rather than a gap between two
 * numbers they can both read.
 *
 * A cancelled trade belongs to neither set. It is the reversal of an event, so
 * it appears in an unfiltered deal listing and in no summary.
 */
export const CANCELLED_ACTIONS = [DEAL_BUY_CANCELED, DEAL_SELL_CANCELED] as const;

/**
 * A stable label for MT5's action, for a screen that must name the row.
 *
 * Unknown codes render as `action <n>` rather than as a guess or a blank. A
 * client seeing an unfamiliar label can quote it to support, where a blank row
 * with an amount beside it is the thing that generates the ticket.
 */
const ACTION_LABELS: Record<number, string> = {
  0: 'buy',
  1: 'sell',
  2: 'balance',
  3: 'credit',
  4: 'charge',
  5: 'correction',
  6: 'bonus',
  7: 'commission',
  8: 'commission_daily',
  9: 'commission_monthly',
  10: 'agent_daily',
  11: 'agent_monthly',
  12: 'interest',
  13: 'buy_canceled',
  14: 'sell_canceled',
  15: 'dividend',
  16: 'dividend_franked',
  17: 'tax',
  18: 'agent',
  19: 'so_compensation',
};

export function dealActionLabel(action: number): string {
  return ACTION_LABELS[action] ?? `action ${action}`;
}
