import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsNumberString, IsString, Length } from 'class-validator';

/**
 * What a partner sends to move earnings into their spending wallet.
 *
 * No destination field, deliberately. There is exactly one place commission can
 * go — the MAIN wallet of the same currency, same owner — so a parameter naming
 * it could only ever be right or be an attempt to send somebody else's money
 * somewhere. `POST /ib/wallet/transfer` means one thing and takes the two
 * pieces of information that vary.
 */
export class IbWalletTransferDto {
  /**
   * Money arrives as a STRING and stays one (§6.1) — `@IsNumberString`, never
   * `@IsNumber`, so it is never parsed into a float on the way in.
   *
   * The POSITIVE check is in the service rather than here. `@IsPositive` would
   * have to parse this to a number to compare it, which is the round trip the
   * money rules exist to prevent; the service compares through decimal.js and
   * the `ib_wallet_transfers_amount_positive` constraint refuses it again at the
   * database.
   */
  @ApiProperty({ type: 'string', example: '250.00000000' })
  @IsNumberString()
  amount: string;

  @ApiProperty({
    example: 'USD',
    description:
      'WHICH commission wallet to draw from. The money lands in the main wallet of the SAME ' +
      'currency — there is no FX rate source in this system, so a cross-currency move is not ' +
      'something this endpoint can offer.',
  })
  @IsString()
  @Length(1, 10)
  currency: string;
}

/**
 * The completed transfer, with BOTH balances it changed.
 *
 * ## Why both, and why they are labelled
 *
 * A partner who has just moved $200 wants to know two things: what is left to
 * move, and what they can now withdraw. Returning one balance sends them to
 * another screen for the other half, and returning two unlabelled figures is
 * the failure `/accounts/[id]` records — two money numbers that differ, with no
 * way to tell which is which, so half the readers act on the wrong one.
 *
 * Read inside the same transaction as the movement, so neither can be a figure
 * from a moment the other does not share.
 */
export class IbWalletTransferResultDto {
  @ApiProperty({ description: 'The `ib_wallet_transfers` row — its id in /transactions too.' })
  id: string;

  @ApiProperty({ type: 'string', example: '250.00000000', description: 'Always positive.' })
  amount: string;

  @ApiProperty({ example: 'USD' })
  currency: string;

  /**
   * Optional because the HISTORY list cannot honestly fill them.
   *
   * `listTransfers` returns past movements, and the balances that mattered then
   * are not the balances now. Restating today's figures beside a three-week-old
   * amount would invite the reader to treat one row's balance as current; the
   * fields are simply absent there, and present on the response to the transfer
   * that produced them.
   */
  @ApiPropertyOptional({
    type: 'string',
    example: '50.00000000',
    description: 'The commission wallet AFTER this transfer. Absent on history rows — see the DTO.',
  })
  commissionBalance?: string;

  @ApiPropertyOptional({
    type: 'string',
    example: '950.00000000',
    description: 'The main wallet AFTER this transfer. Absent on history rows — see the DTO.',
  })
  mainBalance?: string;

  @ApiProperty({ format: 'date-time' })
  createdAt: Date;
}
