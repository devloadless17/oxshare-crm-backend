import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsInt, IsOptional, IsString, Matches, Max, Min } from 'class-validator';
import { Type } from 'class-transformer';

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
      'It is the ONE floating figure this system can state honestly: the bridge exposes no ' +
      'per-position feed, so a per-trade floating column would have to be invented, but the ' +
      'account total falls straight out of two numbers the MT5 server just gave us.\n\n' +
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
 * One page of an account's deals.
 *
 * Paged where the account LIST is not, and the difference is the point: a
 * client holds a handful of accounts and an unbounded number of deals. `total`
 * counts the whole filtered set in the database, so "showing 25 of 312" is a
 * statement about the account's real history rather than about the array that
 * happened to be sent — the same contract `TransactionPageDto` documents.
 */
export class AccountDealPageDto {
  @ApiProperty({ type: [AccountDealDto] }) items: AccountDealDto[];
  @ApiProperty({ description: 'Deals matching the filters, across every page.' }) total: number;
  @ApiProperty() page: number;
  @ApiProperty() limit: number;
}

/**
 * What the account has done, summed in the database.
 *
 * ## Summed in SQL, on NUMERIC, on purpose
 *
 * Postgres sums NUMERIC exactly. Pulling every deal into Node to total it would
 * mean either a float — which §6.1 exists to forbid — or a decimal.js loop over
 * an unbounded row set on every page view. The aggregate is one query and the
 * arithmetic never leaves the column type.
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
 * The filters on an account's deal history.
 *
 * Dates are INCLUSIVE at both ends by DATE PART, matching
 * `ListTransactionsQueryDto` — and for the reason recorded there and in the
 * portal's `date-range.ts`: comparing a timestamp against an end date parsed as
 * midnight excludes almost the whole final day, which is the "my newest row
 * vanished when I set an end date" bug.
 */
export class ListAccountDealsQueryDto {
  @ApiPropertyOptional({
    enum: ['trades', 'balance'],
    description:
      'Narrow to market activity or to money movements. Absent returns everything, including ' +
      'the cancelled deals that are neither.',
  })
  @IsOptional()
  @IsString()
  kind?: 'trades' | 'balance';

  @ApiPropertyOptional({ example: 'EURUSD' })
  @IsOptional()
  @IsString()
  symbol?: string;

  @ApiPropertyOptional({ example: '2026-08-01', description: 'Inclusive, YYYY-MM-DD.' })
  @IsOptional()
  @Matches(DATE_PATTERN, { message: 'from must be a YYYY-MM-DD date' })
  from?: string;

  @ApiPropertyOptional({ example: '2026-08-31', description: 'Inclusive, YYYY-MM-DD.' })
  @IsOptional()
  @Matches(DATE_PATTERN, { message: 'to must be a YYYY-MM-DD date' })
  to?: string;

  @ApiPropertyOptional({ default: 1, minimum: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number;

  /**
   * CAPPED at 100, like the transaction history and for the same reason: an
   * unbounded limit is a request that can ask the database for every deal an
   * account has ever had, and this endpoint is reachable with any session.
   */
  @ApiPropertyOptional({ default: 25, minimum: 1, maximum: 100 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number;
}
