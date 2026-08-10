import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsInt, IsISO8601, IsNotEmpty, IsOptional, IsString, Matches } from 'class-validator';

/**
 * One closed deal, exactly as the MT5 bridge sends it.
 *
 * ── Every amount is a STRING, and validated as one ─────────────────────────
 *
 * `@IsNumber()` here would accept the value into a JavaScript double and undo
 * the whole point of the bridge converting once at the MT5 boundary:
 * `12345678901234567.89` loses its last digits on the way in, before anything
 * has a chance to store it. The regex accepts a signed decimal and the value
 * reaches a NUMERIC column as text.
 *
 * Profit and swap are SIGNED — a losing trade and a negative swap are ordinary —
 * so the pattern allows a leading minus. Volume and price are not, but they use
 * the same pattern rather than a stricter one: a negative volume from MT5 would
 * be a bug worth seeing in the data rather than a 400 the bridge retries forever.
 */
const DECIMAL = /^-?\d+(\.\d+)?$/;

export class Mt5DealDto {
  @ApiProperty({
    description: "MT5's ticket. The idempotency key for ingestion.",
    example: '90210',
  })
  @IsString()
  @IsNotEmpty()
  dealId!: string;

  @ApiProperty({ description: 'The MT5 login the deal belongs to.', example: '5000002' })
  @IsString()
  @IsNotEmpty()
  login!: string;

  @ApiPropertyOptional({ example: '90209' })
  @IsOptional()
  @IsString()
  orderId?: string;

  @ApiPropertyOptional({ example: '90208' })
  @IsOptional()
  @IsString()
  positionId?: string;

  @ApiProperty({ example: 'EURUSD' })
  @IsString()
  @IsNotEmpty()
  symbol!: string;

  @ApiProperty({
    description:
      "MT5's numeric deal action, passed through unmapped — the server adds values across " +
      'builds, and an enum that does not know the newest one would reject the deal rather ' +
      'than store it.',
    example: 0,
  })
  @IsInt()
  action!: number;

  @ApiProperty({ description: "MT5's numeric entry (in / out / inout).", example: 1 })
  @IsInt()
  entry!: number;

  @ApiProperty({ example: '1.00000000' })
  @Matches(DECIMAL, { message: 'volume must be a decimal string' })
  volume!: string;

  @ApiProperty({ example: '1.08542000' })
  @Matches(DECIMAL, { message: 'price must be a decimal string' })
  price!: string;

  @ApiProperty({ description: 'Signed — a loss is negative.', example: '-12.50000000' })
  @Matches(DECIMAL, { message: 'profit must be a decimal string' })
  profit!: string;

  @ApiProperty({ example: '-3.00000000' })
  @Matches(DECIMAL, { message: 'commission must be a decimal string' })
  commission!: string;

  @ApiProperty({ example: '0.00000000' })
  @Matches(DECIMAL, { message: 'swap must be a decimal string' })
  swap!: string;

  @ApiPropertyOptional({ example: 'crm:c-1' })
  @IsOptional()
  @IsString()
  comment?: string;

  @ApiProperty({
    description: 'When MT5 says the deal happened — not when it was ingested.',
    example: '2026-08-10T09:15:00.000Z',
  })
  @IsISO8601()
  dealtAt!: string;
}
