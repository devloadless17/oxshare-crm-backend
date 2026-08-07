import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsNumberString, IsOptional, IsString, IsUUID, Length } from 'class-validator';

/*
 * `DEPOSIT_CURRENCIES` is gone.
 *
 * It was `['USD','USDT'] as const`, mirroring the old `currencyEnum` by hand —
 * so an operator adding EUR in the admin currencies screen would have created a
 * currency clients could hold a wallet in but could not deposit into, with the
 * refusal coming from an `@IsIn` in this file rather than from anything they
 * could see or change. `currency` is a plain string now and
 * `CurrenciesService.assertUsable` decides, which is the one place that knows
 * what is enabled right now.
 */

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
/*
 * The hardcoded `DEPOSIT_METHODS = ['bank_transfer', 'usdt_trc20']` union was
 * HERE, and is gone for the same reason the currency union went before it: the
 * set is operator data now, held in `payment_methods`, and a compile-time list
 * cannot express something the database owns at runtime.
 *
 * What was lost, stated plainly: the compiler no longer catches
 * `method: 'wish'`. That check moved to runtime, where the answer actually
 * lives — `PaymentMethodsService.assertUsable()` refuses an unknown, disabled
 * or unconfigured key, and `transactions_method_key_payment_methods_key_fk`
 * refuses it again at the database if a caller ever skips the service.
 */

export class RequestDepositDto {
  /**
   * Money arrives as a STRING and stays one (§6.1) — `@IsNumberString`, never
   * `@IsNumber`, so it is never parsed into a float on the way in.
   */
  @ApiProperty({ type: 'string', example: '500.00000000' })
  @IsNumberString()
  amount: string;

  @ApiProperty({
    example: 'USD',
    description: 'Must be an enabled currency — see GET /currencies.',
  })
  @IsString()
  currency: string;

  @ApiProperty({
    example: 'whish',
    description: 'How the client is sending the money. Decides which instructions they are shown.',
  })
  @IsString()
  @Length(1, 40)
  method: string;

  /**
   * Fund a TRADING ACCOUNT rather than leaving the money in the wallet.
   *
   * Omit it for an ordinary wallet deposit, which is the common case.
   *
   * The money lands in the wallet either way — the wallet is the CRM's ledger,
   * and a deposit that skipped it would be money with no ledger row. What this
   * does is record the client's intent, so that when the operator confirms the
   * payment the deposit chains a transfer onto the named account. Two visible
   * steps in the data rather than one ambiguous "deposit", which is also what
   * makes the MT5 leg reconcilable later.
   *
   * Must be a LIVE account belonging to the caller; the service refuses demo
   * accounts for the same reason the transfer path does.
   */
  @ApiPropertyOptional({
    description: 'A live trading account of the caller, to fund once the deposit is confirmed.',
  })
  @IsOptional()
  @IsUUID()
  destinationTradingAccountId?: string;
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

  @ApiProperty({ example: 'USD' })
  currency: string;

  @ApiProperty({ example: 'whish', description: 'The `payment_methods.key` used.' })
  method: string;

  @ApiProperty({
    description: 'Always `pending`. Nothing is credited until the operator confirms receipt.',
    example: 'pending',
  })
  state: string;

  @ApiProperty({ format: 'date-time' })
  createdAt: string;
}
