import { ApiProperty } from '@nestjs/swagger';
import { IsIn, IsNumberString } from 'class-validator';

/** The currencies a client can fund an account in. Mirrors `currencyEnum`. */
export const DEPOSIT_CURRENCIES = ['USD', 'USDT'] as const;

/**
 * How the money is actually being sent.
 *
 * NOT the automated providers. `whish` and the USDT gateway are blocked on
 * credentials (ARCHITECTURE §12.5, DECISIONS D-05), and until those land there
 * is no callback to credit a wallet automatically.
 *
 * What is NOT blocked is the flow every broker runs anyway: the client says
 * "I am sending you X", quotes a reference, and the operator confirms the money
 * arrived. That needs no third-party credential, and it is why the deposit
 * screen no longer has to say "waiting on backend endpoints" — the endpoint it
 * was waiting for was the automated one, and this is a different endpoint for a
 * flow that was always available.
 */
export const DEPOSIT_METHODS = ['bank_transfer', 'usdt_trc20'] as const;
export type DepositMethod = (typeof DEPOSIT_METHODS)[number];

export class RequestDepositDto {
  /**
   * Money arrives as a STRING and stays one (§6.1) — `@IsNumberString`, never
   * `@IsNumber`, so it is never parsed into a float on the way in.
   */
  @ApiProperty({ type: 'string', example: '500.00000000' })
  @IsNumberString()
  amount: string;

  @ApiProperty({ enum: DEPOSIT_CURRENCIES })
  @IsIn(DEPOSIT_CURRENCIES)
  currency: (typeof DEPOSIT_CURRENCIES)[number];

  @ApiProperty({
    enum: DEPOSIT_METHODS,
    description: 'How the client is sending the money. Decides which instructions they are shown.',
  })
  @IsIn(DEPOSIT_METHODS)
  method: DepositMethod;
}

/**
 * What the client gets back: a reference to quote on the transfer.
 *
 * The reference is the whole point of the response. An operator reconciling a
 * bank statement has an amount and a name, both of which repeat across clients;
 * the reference is what ties one incoming payment to one declared deposit
 * without a phone call.
 */
export class DepositRequestDto {
  @ApiProperty({ description: 'The transaction id. Also shown on /transactions.' })
  id: string;

  @ApiProperty({
    description: 'Quote this on the transfer. It is what reconciles the payment to this request.',
    example: 'OX-7F3A21',
  })
  reference: string;

  @ApiProperty({ type: 'string', example: '500.00000000' })
  amount: string;

  @ApiProperty({ enum: DEPOSIT_CURRENCIES })
  currency: string;

  @ApiProperty({ enum: DEPOSIT_METHODS })
  method: string;

  @ApiProperty({
    description: 'Always `pending`. Nothing is credited until the operator confirms receipt.',
    example: 'pending',
  })
  state: string;

  @ApiProperty({ format: 'date-time' })
  createdAt: string;
}
