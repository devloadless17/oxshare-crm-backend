import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import { IsArray, IsIn, IsInt, IsOptional, IsString, Matches, Max, Min } from 'class-validator';
import { transactionStateEnum, transactionDirectionEnum } from '../../../database/schema';
import { TransactionDto } from './withdrawal.dto';

/*
 * DERIVED from the columns, never restated.
 *
 * `withdrawal.dto.ts` records what restating one costs: its hand-written state
 * list said `'failed'` where the enum says `'failure'`, so the generated type
 * promised both frontends a state the API can never send and hid the one it
 * does. Reading `enumValues` means a state added to the schema reaches the
 * filter without anybody remembering this file exists.
 */
const STATES = transactionStateEnum.enumValues;
const DIRECTIONS = transactionDirectionEnum.enumValues;

/**
 * The columns a client may order their own history by.
 *
 * An ALLOW-LIST, and that is the whole point: this value reaches an ORDER BY.
 * Interpolating a caller-supplied column name into SQL is the injection this
 * closes, and `@IsIn` is what makes the set closed rather than merely
 * documented. The names are the API's, mapped to columns in the service — a
 * client should not have to know the database spells it `created_at`.
 */
export const TRANSACTION_SORT_FIELDS = [
  'createdAt',
  'amount',
  'direction',
  'currency',
  'state',
] as const;
export type TransactionSortField = (typeof TRANSACTION_SORT_FIELDS)[number];

export const SORT_ORDERS = ['asc', 'desc'] as const;

/**
 * The movement kinds a CLIENT'S history holds — the union's own vocabulary.
 *
 * One more than the admin's `TRANSACTION_KINDS`: `rebate` is an arm only the
 * client list carries (see `movementsCte`), so a client can ask for it and an
 * operator's Financial list cannot contain it.
 */
export const CLIENT_TRANSACTION_KINDS = [
  'payment',
  'transfer',
  'commission_transfer',
  'rebate',
] as const;
export type ClientTransactionKind = (typeof CLIENT_TRANSACTION_KINDS)[number];

/** `YYYY-MM-DD`, matching what the portal's date-range picker holds. */
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/**
 * How a client narrows, orders and pages their own transaction history.
 *
 * ## ⚠️ Why this exists at all
 *
 * `GET /payments/transactions` took NO parameters and answered with a bare
 * array capped at `.limit(100)`. The portal filtered, sorted and counted that
 * array in the browser — and both apps' notes described it as "the client's
 * whole history", which the `limit` had quietly made false.
 *
 * So a client with 150 movements filtered the newest 100, and the screen told
 * them "showing 4 of 100" while 150 existed. PLATFORM-CONVENTIONS R-2.5 names
 * exactly this: presenting a filter over one page as a filter over the history
 * under-reports a client's own money, and this is the money screen a client
 * would use to detect an error in the ledger.
 *
 * Every parameter here is therefore applied by the DATABASE, against the whole
 * table, and `total` counts the real matching set.
 *
 * ## Everything is optional, and absent means "no constraint"
 *
 * A request with no query string returns the newest page of everything — the
 * behaviour the endpoint had before, minus the silent cap.
 */
export class ListTransactionsQueryDto {
  /**
   * Which KINDS of movement — comma-separated, any of them.
   *
   * The portal's Deposit, Withdraw and Transfer screens each list their own
   * history, and `direction` cannot draw those lines: a transfer back from a
   * trading account is a `deposit` from the wallet's side, so "deposits" by
   * direction alone would list it beside card payments. `kind=payment` with a
   * direction is a deposit history; `kind=transfer,commission_transfer` is the
   * transfer history.
   */
  @ApiPropertyOptional({
    type: String,
    example: 'transfer,commission_transfer',
    description: `Comma-separated. Any of: ${CLIENT_TRANSACTION_KINDS.join(', ')}.`,
  })
  @IsOptional()
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string'
      ? value
          .split(',')
          .map((part) => part.trim())
          .filter(Boolean)
      : value,
  )
  @IsArray()
  @IsIn(CLIENT_TRANSACTION_KINDS, { each: true })
  kind?: ClientTransactionKind[];

  @ApiPropertyOptional({ enum: DIRECTIONS, description: 'Deposits or withdrawals only.' })
  @IsOptional()
  @IsIn(DIRECTIONS)
  direction?: (typeof DIRECTIONS)[number];

  @ApiPropertyOptional({ enum: STATES })
  @IsOptional()
  @IsIn(STATES)
  state?: (typeof STATES)[number];

  @ApiPropertyOptional({ example: 'USD' })
  @IsOptional()
  @IsString()
  currency?: string;

  /**
   * INCLUSIVE at both ends, by DATE PART.
   *
   * `date-range.ts` in the portal records why this is not negotiable: comparing
   * a timestamp against an end date parsed as midnight excludes almost the whole
   * final day — the "my newest transaction vanished when I set an end date" bug.
   * The service compares date parts so there is no end-of-day arithmetic to get
   * wrong.
   */
  @ApiPropertyOptional({ example: '2026-08-01', description: 'Inclusive, YYYY-MM-DD.' })
  @IsOptional()
  @Matches(DATE_PATTERN, { message: 'from must be a YYYY-MM-DD date' })
  from?: string;

  @ApiPropertyOptional({ example: '2026-08-31', description: 'Inclusive, YYYY-MM-DD.' })
  @IsOptional()
  @Matches(DATE_PATTERN, { message: 'to must be a YYYY-MM-DD date' })
  to?: string;

  @ApiPropertyOptional({ enum: TRANSACTION_SORT_FIELDS, default: 'createdAt' })
  @IsOptional()
  @IsIn(TRANSACTION_SORT_FIELDS)
  sort?: TransactionSortField;

  @ApiPropertyOptional({ enum: SORT_ORDERS, default: 'desc' })
  @IsOptional()
  @IsIn(SORT_ORDERS)
  order?: (typeof SORT_ORDERS)[number];

  /*
   * `@Type(() => Number)` because a query string is text and the global pipe
   * runs with `transform: true`. Without it `@IsInt` sees `'2'` and refuses
   * every paged request.
   */
  @ApiPropertyOptional({ default: 1, minimum: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number;

  /**
   * CAPPED at 100.
   *
   * Not a preference — an unbounded `limit` is a request that can ask the
   * database for every row a client has ever had in one query, and this endpoint
   * is reachable by anybody with a session.
   */
  @ApiPropertyOptional({ default: 25, minimum: 1, maximum: 100 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number;
}

/**
 * One page of history, with the count of everything that matched.
 *
 * `total` is what makes the screen honest: it counts the whole filtered set in
 * the database, so "showing 25 of 312" is a statement about the client's actual
 * history rather than about the array that happened to be sent. That number is
 * the one the old bare-array shape could not express.
 */
export class TransactionPageDto {
  @ApiProperty({ type: [TransactionDto] }) items: TransactionDto[];

  @ApiProperty({ description: 'Rows matching the filters, across every page.' })
  total: number;

  @ApiProperty() page: number;
  @ApiProperty() limit: number;
}

/**
 * One (currency, direction, state) cell of a client's filtered history — the totals behind
 * the summary tiles on the Deposit, Withdraw and Transfer screens.
 *
 * Summed BY THE DATABASE over every matching row. The alternative, adding up
 * the page the screen happens to hold, is the R-2.5 under-report this DTO file
 * opens with: a total over 25 rows presented as a total over the history.
 * Per currency because there is no FX source — USD and USDT never share a sum.
 */
export class TransactionSummaryRowDto {
  @ApiProperty({ example: 'USD' }) currency: string;
  @ApiProperty({ enum: DIRECTIONS, description: "Wallet-side, as on the list's rows." })
  direction: (typeof DIRECTIONS)[number];
  @ApiProperty({ enum: STATES }) state: (typeof STATES)[number];
  @ApiProperty() count: number;
  @ApiProperty({ type: 'string', example: '1250.00000000', description: 'Decimal string (§6.1).' })
  total: string;
}
