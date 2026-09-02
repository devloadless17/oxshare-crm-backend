import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsArray,
  IsInt,
  IsISO8601,
  IsNotEmpty,
  IsOptional,
  IsString,
  Matches,
  ValidateNested,
} from 'class-validator';

/**
 * One live reading of an account, pushed by the bridge for a client who is
 * looking at it right now.
 *
 * ── Why this carries what `Mt5AccountSnapshotDto` deliberately refuses ─────
 *
 * That DTO takes the balance and NOTHING else, and its own note explains why:
 * equity and margin move on every tick, so a copy is stale the moment it is
 * stored, and a stale equity beside a real login is the most expensive kind of
 * wrong number on a trading product.
 *
 * That reasoning is about STORING them. This payload is never stored — it is
 * announced on a Postgres channel, fanned out to whatever socket is open, and
 * forgotten. The figure reaches a screen carrying the instant it was read, which
 * is the whole difference between a live number and a stale one wearing the same
 * label.
 *
 * So: if you are ever tempted to write one of these fields into a column,
 * re-read `Mt5AccountSnapshotDto`. The two DTOs disagree on purpose and the
 * disagreement is the design.
 *
 * ── Decimal STRINGS, like everything else that is money ────────────────────
 *
 * §6.1. `@IsNumber()` would accept these into a JavaScript double and undo the
 * bridge's one conversion at the MT5 boundary. Signed, because floating P/L is
 * negative about as often as it is positive and equity on a stopped-out account
 * can be a debit.
 */
const DECIMAL = /^-?\d+(\.\d+)?$/;

export class Mt5LivePositionDto {
  @ApiProperty({ description: 'MT5 position ticket. A string — see the login note.' })
  @IsString()
  @IsNotEmpty()
  ticket!: string;

  @ApiProperty({ example: 'EURUSD' })
  @IsString()
  @IsNotEmpty()
  symbol!: string;

  @ApiProperty({ description: "MT5's numeric side: 0 buy, 1 sell. Passed through.", example: 0 })
  @IsInt()
  action!: number;

  @ApiProperty({ example: '0.10000000' })
  @IsString()
  @Matches(DECIMAL, { message: 'volume must be a decimal string' })
  volume!: string;

  @ApiProperty({ example: '1.09000000' })
  @IsString()
  @Matches(DECIMAL, { message: 'priceOpen must be a decimal string' })
  priceOpen!: string;

  @ApiProperty({ example: '1.09120000' })
  @IsString()
  @Matches(DECIMAL, { message: 'priceCurrent must be a decimal string' })
  priceCurrent!: string;

  @ApiPropertyOptional({
    description:
      'NULL when unset. MT5 stores an absent stop as the price 0, and rendering that as 0.00 ' +
      'reads as an order to close at zero.',
    nullable: true,
  })
  @IsOptional()
  @IsString()
  @Matches(DECIMAL, { message: 'stopLoss must be a decimal string' })
  stopLoss?: string | null;

  @ApiPropertyOptional({ nullable: true })
  @IsOptional()
  @IsString()
  @Matches(DECIMAL, { message: 'takeProfit must be a decimal string' })
  takeProfit?: string | null;

  @ApiProperty({ description: 'Floating result on this position.', example: '-12.40000000' })
  @IsString()
  @Matches(DECIMAL, { message: 'profit must be a decimal string' })
  profit!: string;

  @ApiProperty({ example: '0.00000000' })
  @IsString()
  @Matches(DECIMAL, { message: 'swap must be a decimal string' })
  swap!: string;

  @ApiPropertyOptional({
    description:
      'NULL on the Manager protocol, which reports commission on deals rather than positions — ' +
      'not the same claim as "0".',
    nullable: true,
  })
  @IsOptional()
  @IsString()
  @Matches(DECIMAL, { message: 'commission must be a decimal string' })
  commission?: string | null;

  @ApiPropertyOptional({
    description: "MT5's own comment on the position. NULL when blank.",
    nullable: true,
  })
  @IsOptional()
  @IsString()
  comment?: string | null;

  @ApiProperty({ example: '2026-09-02T09:15:00.000Z' })
  @IsISO8601()
  openedAt!: string;
}

export class Mt5LiveDto {
  @ApiProperty({
    description: 'The MT5 login. A STRING — leading zeros are significant to the bridge.',
    example: '00012345',
  })
  @IsString()
  @IsNotEmpty()
  login!: string;

  @ApiProperty({ example: 'USD' })
  @IsString()
  @IsNotEmpty()
  currency!: string;

  @ApiProperty({ example: '1250.00000000' })
  @IsString()
  @Matches(DECIMAL, { message: 'balance must be a decimal string' })
  balance!: string;

  @ApiProperty({
    description: 'Balance plus floating profit — what the client can act on.',
    example: '1237.60000000',
  })
  @IsString()
  @Matches(DECIMAL, { message: 'equity must be a decimal string' })
  equity!: string;

  @ApiProperty({ example: '0.00000000' })
  @IsString()
  @Matches(DECIMAL, { message: 'credit must be a decimal string' })
  credit!: string;

  @ApiProperty({ example: '33.00000000' })
  @IsString()
  @Matches(DECIMAL, { message: 'margin must be a decimal string' })
  margin!: string;

  @ApiProperty({ example: '1204.60000000' })
  @IsString()
  @Matches(DECIMAL, { message: 'marginFree must be a decimal string' })
  marginFree!: string;

  @ApiPropertyOptional({
    description:
      'NULL when the account has no margin requirement at all. Zero and "not applicable" are ' +
      'different answers — a literal 0 here reads as a margin call.',
    nullable: true,
  })
  @IsOptional()
  @IsString()
  @Matches(DECIMAL, { message: 'marginLevel must be a decimal string' })
  marginLevel?: string | null;

  @ApiProperty({
    description:
      'When the BRIDGE read MT5 — not when this was delivered. The screen renders it, so a ' +
      'client can see exactly how old the figures in front of them are.',
    example: '2026-09-02T12:00:00.000Z',
  })
  @IsISO8601()
  readAt!: string;

  @ApiProperty({
    description:
      'The open positions at that same instant. An EMPTY array means the account has nothing ' +
      'open — a real answer from MT5, not a missing field.',
    type: [Mt5LivePositionDto],
  })
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => Mt5LivePositionDto)
  positions!: Mt5LivePositionDto[];
}
