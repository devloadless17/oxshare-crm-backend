import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, Matches } from 'class-validator';

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/**
 * What MT5 says about ONE account, right now.
 *
 * ## This is the live figure, and the list endpoint's is not
 *
 * `TradingAccountDto.balance` is the CRM's cached column — what a wallet
 * transfer credited, correct until the client's first trade moves it. This DTO
 * is a read THROUGH the bridge to the MT5 server, so it is the authority.
 *
 * Both exist on purpose and a screen must be explicit about which it is
 * showing. The list can be rendered without a network call to a server we do
 * not own; the detail screen, which is where a client checks their money,
 * cannot afford the cached answer.
 *
 * ## Every figure is a decimal STRING (§6.1)
 *
 * Converted once at the MT5 boundary inside the bridge, from the doubles the
 * Manager API deals in, and never parsed again on the way through.
 */
export class AccountSnapshotDto {
  @ApiProperty({ description: 'The MT5 login these figures belong to.', example: '5000002' })
  login: string;

  @ApiProperty({ example: 'demo\\Standard' })
  group: string;

  @ApiProperty({ example: 'USD' })
  currency: string;

  @ApiProperty({ description: 'The ratio denominator — 500 means 1:500.', example: 500 })
  leverage: number;

  @ApiProperty({
    type: 'string',
    example: '1250.00000000',
    description: 'Cash balance, EXCLUDING floating profit. Decimal string (§6.1).',
  })
  balance: string;

  @ApiProperty({
    type: 'string',
    example: '1312.40000000',
    description: 'Balance plus credit plus floating profit — what the client can act on.',
  })
  equity: string;

  @ApiProperty({ type: 'string', example: '0.00000000' })
  credit: string;

  @ApiProperty({ type: 'string', example: '120.00000000' })
  margin: string;

  @ApiProperty({ type: 'string', example: '1192.40000000' })
  marginFree: string;

  @ApiProperty({
    type: 'string',
    nullable: true,
    example: '1093.66',
    description:
      'NULL when the account has no margin requirement at all — no open positions. Zero and ' +
      '"not applicable" are different answers and must render differently, so this is not ' +
      'defaulted to 0.',
  })
  marginLevel: string | null;

  @ApiProperty({
    type: 'string',
    example: '62.40000000',
    description:
      'Unrealised profit across every open position: equity - balance - credit.\n\n' +
      'Derived here rather than stored, and derived from MT5 rather than from our own tables. ' +
      'This is the ACCOUNT total; the per-position breakdown is on `/positions`.\n\n' +
      'The two are read independently — this from the account snapshot, that from the position ' +
      'list — so they can differ by a tick. Neither is derived from the other on purpose: making ' +
      'them agree would mean choosing one as the truth and recomputing the other from it, which ' +
      'would hide a real disagreement rather than show it.\n\n' +
      'Signed — a client underwater is negative.',
  })
  floating: string;
}

/**
 * One deal on the account, as its owner sees it.
 *
 * Deliberately NOT the ingestion DTO (`mt5/dto/mt5-deal.dto.ts`): that one is
 * the bridge's wire format, carries MT5 order and position ids, and is
 * validated for writing. This is a read shape for a person, and drops the ids
 * that mean nothing outside the terminal.
 *
 * `action` and `entry` survive as raw numbers ALONGSIDE the label, so a support
 * conversation about an unfamiliar row has the code MT5 itself would quote.
 */
export class AccountDealDto {
  @ApiProperty({ description: "MT5's ticket.", example: '90210' })
  ticket: string;

  @ApiProperty({ example: 'EURUSD' })
  symbol: string;

  @ApiProperty({ description: "MT5's raw numeric action.", example: 0 })
  action: number;

  @ApiProperty({
    description:
      'A stable name for the action — "buy", "balance", "commission". Unknown codes ' +
      'render as "action <n>" rather than as a guess.',
    example: 'buy',
  })
  actionLabel: string;

  @ApiProperty({
    description: "MT5's raw numeric entry: 0 in, 1 out, 2 inout, 3 out_by.",
    example: 1,
  })
  entry: number;

  @ApiProperty({
    description: 'True when this deal realised a result rather than opening a position.',
  })
  closing: boolean;

  @ApiProperty({ type: 'string', example: '1.00000000' })
  volume: string;

  @ApiProperty({ type: 'string', example: '1.08542000' })
  price: string;

  @ApiProperty({
    type: 'string',
    example: '-12.50000000',
    description: 'Signed. A loss is negative.',
  })
  profit: string;

  @ApiProperty({ type: 'string', example: '-3.00000000' })
  commission: string;

  @ApiProperty({ type: 'string', example: '0.00000000' })
  swap: string;

  @ApiPropertyOptional({ type: 'string', nullable: true })
  comment: string | null;

  @ApiProperty({
    format: 'date-time',
    description: 'When MT5 says it happened — NOT when we ingested it.',
  })
  dealtAt: Date;
}

/**
 * One OPEN position, read live from MT5.
 *
 * ## Nothing here is stored, and that is the point
 *
 * `profit` is the FLOATING result: it moves on every tick, so a persisted copy
 * is stale the moment it is written. The CRM has a `positions` table that
 * nothing writes to, and it must stay that way — a sweep filling it would show
 * a client a minute-old floating P/L wearing the same label as a live one.
 *
 * Every amount is a decimal string (§6.1), converted once at the MT5 boundary.
 */
export class AccountPositionDto {
  @ApiProperty({ description: "MT5's position id — one per position, not per deal." })
  ticket: string;

  @ApiProperty({ example: 'EURUSD' })
  symbol: string;

  @ApiProperty({ description: "MT5's numeric side: 0 buy, 1 sell.", example: 0 })
  action: number;

  @ApiProperty({
    enum: ['buy', 'sell'],
    description: 'The side, named. Unknown codes pass through raw.',
  })
  side: string;

  @ApiProperty({ type: 'string', example: '1.00000000' })
  volume: string;

  @ApiProperty({ type: 'string', example: '1.08542000' })
  priceOpen: string;

  @ApiProperty({ type: 'string', example: '1.08610000', description: 'The live market price.' })
  priceCurrent: string;

  @ApiProperty({
    type: 'string',
    nullable: true,
    description:
      'NULL when unset. MT5 stores an absent stop as the price 0, and a stop loss rendered as ' +
      '0.00 reads as an order to close at zero.',
  })
  stopLoss: string | null;

  @ApiProperty({
    type: 'string',
    nullable: true,
    description: 'NULL when unset, as with stopLoss.',
  })
  takeProfit: string | null;

  @ApiProperty({
    type: 'string',
    example: '62.40000000',
    description: 'FLOATING profit or loss, signed. Live — it changes on every tick.',
  })
  profit: string;

  @ApiProperty({ type: 'string', example: '-1.20000000', description: 'Signed.' })
  swap: string;

  @ApiProperty({
    type: 'string',
    nullable: true,
    description:
      'NULL on the Manager protocol, which carries commission on deals rather than on the open ' +
      'position. Not interchangeable with "0", which would claim a fee-free position.',
  })
  commission: string | null;

  @ApiProperty({ type: 'string', nullable: true })
  comment: string | null;

  @ApiProperty({ format: 'date-time' })
  openedAt: Date;
}

/**
 * What the account did in the window, computed from the deals in it.
 *
 * ## Computed in the backend on decimal.js, and the window is what makes that safe
 *
 * This used to be a SQL aggregate over the ingested `mt5_deals` table, which was
 * exact and unbounded but could only report what the sweep had managed to
 * ingest. Reading live moves the arithmetic into Node — where §6.1 forbids
 * floats, so every total goes through decimal.js — and the 31-day ceiling on the
 * window is what keeps that loop bounded.
 *
 * ## The figures describe the WINDOW, never all time
 *
 * `AccountHistoryDto` echoes the period for this reason. "12 trades" means
 * twelve in the selected window, and a caller rendering it without the dates is
 * making a claim the data does not support.
 *
 * ## Only CLOSED round trips are counted
 *
 * Every count and total here is over deals that realised a result. An opening
 * deal carries `profit = 0`, so counting opens would halve the average result
 * and drag the win rate down by one guaranteed non-winning row per position.
 * Balance operations are excluded for a blunter reason: a deposit is not a
 * winning trade.
 *
 * ## `wins + losses` need not equal `trades`
 *
 * A trade closing at exactly zero is neither, and that is not a rounding
 * artefact — a scratch exit is ordinary. Anything computing a win rate must
 * divide by `trades`, and anything rendering the two counts must not present
 * them as a complete partition.
 */
export class AccountStatsDto {
  @ApiProperty({ description: 'Closed round trips. The denominator for a win rate.' })
  trades: number;

  @ApiProperty({ description: 'Closed trades with profit > 0.' })
  wins: number;

  @ApiProperty({ description: 'Closed trades with profit < 0. See the DTO note on scratch exits.' })
  losses: number;

  @ApiProperty({ type: 'string', example: '14.50000000', description: 'Lots closed.' })
  volume: string;

  @ApiProperty({
    type: 'string',
    example: '840.20000000',
    description: 'Realised profit and loss, net and signed. Excludes floating — see the snapshot.',
  })
  netProfit: string;

  @ApiProperty({ type: 'string', example: '1290.00000000', description: 'Sum of winning trades.' })
  grossProfit: string;

  @ApiProperty({
    type: 'string',
    example: '-449.80000000',
    description: 'Sum of losing trades. NEGATIVE, as stored — not an absolute value.',
  })
  grossLoss: string;

  @ApiProperty({
    type: 'string',
    example: '-38.00000000',
    description: 'Signed: a charge is negative.',
  })
  commission: string;

  @ApiProperty({ type: 'string', example: '-4.20000000', description: 'Signed.' })
  swap: string;

  @ApiProperty({
    type: 'string',
    nullable: true,
    description: 'Best single closed trade. Null with no trades.',
  })
  bestTrade: string | null;

  @ApiProperty({
    type: 'string',
    nullable: true,
    description: 'Worst single closed trade. Null with no trades.',
  })
  worstTrade: string | null;

  @ApiProperty({ type: 'string', format: 'date-time', nullable: true })
  firstDealAt: Date | null;

  @ApiProperty({ type: 'string', format: 'date-time', nullable: true })
  lastDealAt: Date | null;
}

/**
 * An account's activity over ONE window: the statistics and the deals behind
 * them.
 *
 * ## Why both come back together
 *
 * They are two views of the same fetch. Splitting them into two endpoints would
 * mean two reads of the same window from MT5 — twice the latency and twice the
 * load on a server we do not own — and, worse, two windows that can disagree:
 * a client would see totals computed over one set beside a list showing another.
 *
 * `from` and `to` are echoed back so the screen can state the period it is
 * describing. A statistics panel that does not say what it covers gets read as
 * all-time.
 */
export class AccountHistoryDto {
  @ApiProperty({ format: 'date-time', description: 'Start of the window, inclusive.' })
  from: Date;

  @ApiProperty({ format: 'date-time', description: 'End of the window, inclusive.' })
  to: Date;

  @ApiProperty({ type: () => AccountStatsDto })
  stats: AccountStatsDto;

  @ApiProperty({ type: [AccountDealDto], description: 'Newest first.' })
  deals: AccountDealDto[];
}

/**
 * The window an account's history is read over.
 *
 * ## A window, not a page
 *
 * The old shape here was offset pagination over an ingested table. Reading live
 * changes what a bound has to do: MT5 answers per time range, and it TRUNCATES a
 * large range silently rather than erroring — so the bound must be on the
 * period, where the server's own limit is, and not on a row count the server
 * knows nothing about.
 *
 * Dates are INCLUSIVE at both ends by DATE PART, matching
 * `ListTransactionsQueryDto` — and for the reason recorded there and in the
 * portal's `date-range.ts`: treating the end date as midnight excludes almost
 * the whole final day, which is the "my newest row vanished when I set an end
 * date" bug.
 */
export class AccountHistoryQueryDto {
  @ApiPropertyOptional({
    example: '2026-08-01',
    description: 'Inclusive, YYYY-MM-DD. Defaults to 30 days before `to`.',
  })
  @IsOptional()
  @Matches(DATE_PATTERN, { message: 'from must be a YYYY-MM-DD date' })
  from?: string;

  @ApiPropertyOptional({
    example: '2026-08-31',
    description: 'Inclusive, YYYY-MM-DD. Defaults to today.',
  })
  @IsOptional()
  @Matches(DATE_PATTERN, { message: 'to must be a YYYY-MM-DD date' })
  to?: string;
}
