import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { NoClientFields } from '../../../common/security/client-field.decorator';
import { IsIn, IsString, IsUUID, Matches } from 'class-validator';

export const TRANSFER_DIRECTIONS = ['wallet_to_account', 'account_to_wallet'] as const;

export class RequestTransferDto {
  @ApiProperty({ description: 'A live trading account belonging to the caller.' })
  @IsUUID()
  tradingAccountId: string;

  @ApiProperty({ enum: TRANSFER_DIRECTIONS })
  @IsIn(TRANSFER_DIRECTIONS)
  direction: (typeof TRANSFER_DIRECTIONS)[number];

  /**
   * A decimal STRING, never a number.
   *
   * ARCHITECTURE §6.1: NUMERIC(28,8) does not survive a JS number, and
   * `12345678901234567.89` is already wrong before any arithmetic begins. The
   * pattern also refuses more than eight decimal places rather than letting the
   * database round money silently.
   */
  @ApiProperty({ example: '250.00', description: 'Decimal string, up to 8 places.' })
  @IsString()
  @Matches(/^\d+(\.\d{1,8})?$/, {
    message: 'amount must be a positive decimal string with at most 8 decimal places',
  })
  amount: string;

  @ApiProperty({ example: 'USD' })
  @IsString()
  currency: string;
}

@NoClientFields('a transfer between a wallet and a trading account, addressed by ids')
export class TransferDto {
  @ApiProperty() id: string;
  @ApiProperty({ type: 'integer' }) userId: number;
  @ApiProperty() walletId: string;
  @ApiProperty() tradingAccountId: string;
  @ApiProperty({ enum: TRANSFER_DIRECTIONS }) direction: string;

  @ApiProperty({ type: 'string', example: '250.00000000', description: 'Decimal string (§6.1).' })
  amount: string;

  @ApiProperty({ example: 'USD' }) currency: string;

  @ApiProperty({
    enum: ['pending', 'settled', 'failed'],
    description:
      'pending until the MT5 bridge confirms. A wallet_to_account transfer holds the amount ' +
      'while pending; an account_to_wallet one credits nothing until it settles.',
  })
  state: string;

  // `type` spelled out on the nullable fields: `nullable: true` on its own
  // emits a typeless schema, which openapi-typescript renders as
  // `Record<string, never> | null` in both frontends.
  @ApiPropertyOptional({ type: 'string', nullable: true }) failureReason: string | null;
  @ApiPropertyOptional({ type: 'string', format: 'date-time', nullable: true })
  settledAt: Date | null;
  @ApiProperty() createdAt: Date;
}
