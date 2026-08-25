import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsInt, IsISO8601, IsNotEmpty, IsOptional, IsString, Matches, Min } from 'class-validator';

/**
 * What MT5 holds on one account, as the bridge pushes it.
 *
 * ── A STRING for the balance, validated as one ─────────────────────────────
 *
 * The same rule `Mt5DealDto` states and for the same reason: `@IsNumber()` would
 * accept the value into a JavaScript double and undo the bridge's one conversion
 * at the MT5 boundary. The regex accepts a signed decimal and the value reaches
 * a NUMERIC column as text.
 *
 * SIGNED, because a balance can be negative. An account stopped out through zero
 * carries a debit until the broker settles it, and refusing that number would
 * make the one account an operator most needs to see the one the sync cannot
 * deliver.
 *
 * ── Balance only. NOT equity, margin or free margin ────────────────────────
 *
 * The bridge's `AccountSnapshot` carries all of them and this DTO deliberately
 * takes one. Equity and margin are computed from live prices against open trades
 * and change on every tick, so a copy is stale the moment it is stored — and a
 * stale equity beside a real login is the most expensive kind of wrong number on
 * a trading product. They stay live-only, read on the detail screen where
 * somebody is actually looking at one account.
 *
 * Balance is mirrorable precisely because it moves only on a discrete event: a
 * deal closing, a dealer operation, an overnight swap charge.
 */
const DECIMAL = /^-?\d+(\.\d+)?$/;

export class Mt5AccountSnapshotDto {
  @ApiProperty({
    description:
      'The MT5 login this snapshot describes. A STRING — leading zeros are significant to the ' +
      'bridge, and parsing it as a number would make `00012345` and `12345` the same account.',
    example: '00012345',
  })
  @IsString()
  @IsNotEmpty()
  login!: string;

  @ApiProperty({
    description:
      "MT5's cash balance, excluding floating profit. A decimal STRING (§6.1), signed — a " +
      'stopped-out account can hold a debit.',
    example: '1250.00000000',
  })
  @IsString()
  @Matches(DECIMAL, { message: 'balance must be a decimal string' })
  balance!: string;

  @ApiProperty({
    description:
      'When the bridge read this from MT5 — NOT when it was delivered. Deliveries retry with ' +
      'backoff and can arrive out of order, so the ingest compares this against what it already ' +
      'holds and refuses to move a balance backwards in time.',
    example: '2026-08-20T12:00:00.000Z',
  })
  @IsISO8601()
  readAt!: string;

  @ApiPropertyOptional({
    description:
      'The MT5 group, if the bridge read it in the same call. Recorded when it disagrees with ' +
      'what we hold — a group moved on the server is how an account silently changes product.',
    example: 'real\\Standard',
  })
  @IsOptional()
  @IsString()
  group?: string;

  @ApiPropertyOptional({
    description:
      'MT5 bonus CREDIT, if read in the same call. A decimal string like every money field ' +
      'here. Stored beside the balance because it moves on a discrete dealer action rather ' +
      'than on every tick — and it is never summed into the balance, because it is not the ' +
      "client's money to withdraw.",
    example: '250.00000000',
  })
  @IsOptional()
  @Matches(/^-?\d+(\.\d+)?$/, { message: 'credit must be a decimal string' })
  credit?: string;

  @ApiPropertyOptional({
    description: 'Leverage as MT5 reports it, if read in the same call.',
    example: 500,
  })
  @IsOptional()
  @IsInt()
  @Min(0)
  leverage?: number;
}
