import { ApiProperty } from '@nestjs/swagger';
import { positionSideEnum, positionStatusEnum } from '../../../database/schema';

export const POSITION_SIDES = positionSideEnum.enumValues;
export const POSITION_STATUSES = positionStatusEnum.enumValues;

export type PositionSide = (typeof POSITION_SIDES)[number];
export type PositionStatus = (typeof POSITION_STATUSES)[number];

/**
 * One trade, as its owner sees it.
 *
 * ## This endpoint returns an empty list today, and that is the honest answer
 *
 * Nothing writes to `positions` — there is no MT5 bridge, so no ingestion path
 * exists. The table and this DTO are in place so the portal renders against a
 * REAL query that returns zero rows, rather than a hardcoded empty state that
 * would need rewriting the day a feed lands.
 *
 * The difference is not academic: a screen showing a fixed "nothing here" is
 * indistinguishable from one whose query genuinely found nothing, and that
 * confusion has already told a client with three live accounts they had none.
 *
 * ## What is NOT here
 *
 * Unrealised (floating) P/L. It changes on every tick and is computed against a
 * live price nothing in this system holds — a stored figure would be stale the
 * moment it was written, and a trader reading an hour-old floating loss as
 * current is exactly the wrong number to put on a screen.
 *
 * `profit` is the REALISED result and is null until the position closes.
 */
export class PositionDto {
  @ApiProperty() id: string;

  @ApiProperty({ description: 'The trading account this was traded on.' })
  tradingAccountId: string;

  @ApiProperty({
    type: 'string',
    nullable: true,
    description: "The account's MT5 login, for display beside the trade. Null until assigned.",
  })
  login: string | null;

  @ApiProperty({ description: "The broker's own identifier for this trade." })
  ticket: string;

  @ApiProperty({ example: 'EURUSD' })
  symbol: string;

  @ApiProperty({ enum: POSITION_SIDES })
  side: PositionSide;

  @ApiProperty({
    type: 'string',
    example: '0.1000',
    description: 'Lots, as a decimal string. Never a float — 0.01 is a valid size.',
  })
  volume: string;

  @ApiProperty({ type: 'string', example: '1.0854300000' })
  openPrice: string;

  @ApiProperty({
    type: 'string',
    nullable: true,
    description: 'Null while the position is open — it does not exist yet.',
  })
  closePrice: string | null;

  @ApiProperty({ type: 'string', nullable: true })
  stopLoss: string | null;

  @ApiProperty({ type: 'string', nullable: true })
  takeProfit: string | null;

  @ApiProperty({
    type: 'string',
    nullable: true,
    example: '125.40000000',
    description:
      'REALISED result, signed, written only at close (§6.1 decimal string). Null while open — ' +
      'this is deliberately NOT floating P/L.',
  })
  profit: string | null;

  @ApiProperty({ type: 'string', nullable: true })
  swap: string | null;

  @ApiProperty({ type: 'string', nullable: true })
  commission: string | null;

  @ApiProperty()
  currency: string;

  @ApiProperty({ enum: POSITION_STATUSES })
  status: PositionStatus;

  @ApiProperty({ format: 'date-time' })
  openedAt: Date;

  @ApiProperty({ type: 'string', format: 'date-time', nullable: true })
  closedAt: Date | null;
}
