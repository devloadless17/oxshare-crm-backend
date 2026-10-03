import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsNumberString, IsObject, IsOptional, IsString, IsUUID, Length } from 'class-validator';
import { NoClientFields } from '../../../common/security/client-field.decorator';
import { PROOF_FIELD_TYPES, type ProofFieldType } from '../../../common/payments/proof-fields';

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
 * One answer a client gave with an offline deposit (0163), as filed: the label
 * is the question AS ASKED, so a field renamed or deleted since still reads.
 *
 * Never masked (the owner's ruling): the answers are PROOF of a payment, which
 * the desk approves the deposit on — like the receipt beside them.
 */
@NoClientFields(
  'proof of a payment the client filed with the receipt, which the desk must always see',
)
export class ProofDetailDto {
  @ApiProperty({ example: 'f_k3m9x2q7ab' })
  fieldId: string;

  @ApiProperty({ example: 'Phone number you sent from', description: 'The question as asked.' })
  label: string;

  @ApiPropertyOptional({
    type: String,
    nullable: true,
    example: 'رقم الهاتف الذي أرسلت منه',
    description:
      'The question in Arabic as asked (0179), when the field had one at filing. Absent on ' +
      'answers filed before it, or to an untranslated field — show `label`.',
  })
  labelAr?: string | null;

  @ApiProperty({ enum: PROOF_FIELD_TYPES, example: 'phone' })
  type: ProofFieldType;

  @ApiProperty({ example: '+96170123456', description: 'A phone is E.164.' })
  value: string;
}

/**
 * The OFFLINE form: the same fields, plus the answers to the method's details.
 *
 * Sent as multipart `details[<fieldId>]` parts, which multer folds into one
 * object. Only its SHAPE is checked here; what it must hold — which fields,
 * required or not, a real phone — is judged against the method's own
 * configuration by `readProofDetails`, refused per field as `details.<fieldId>`.
 */
export class OfflineDepositDto extends RequestDepositDto {
  @ApiPropertyOptional({
    type: 'object',
    additionalProperties: { type: 'string' },
    example: { f_k3m9x2q7ab: '+961 70 123 456' },
    description:
      "Answers to the method's `proofFields`, keyed by field id — e.g. the phone the money " +
      'was sent from, or a transfer code. Sent as `details[<id>]` form parts.',
  })
  @IsOptional()
  @IsObject()
  details?: Record<string, string>;
}

/**
 * What the client gets back: a reference to quote on the transfer.
 *
 * The reference is the whole point of the response. An operator reconciling a
 * bank statement has an amount and a name, both of which repeat across clients;
 * the reference is what ties one incoming payment to one declared deposit
 * without a phone call.
 */
/**
 * A hosted deposit's state as its OWNER sees it (0174): the waiting card and
 * the return page. `amount` is what was CREDITED once it settled — on a
 * provider that credits what arrived (3pay) it can differ from what was asked,
 * and the client must be told the real figure, not the one they typed.
 */
export class DepositStateDto {
  @ApiProperty({ enum: ['pending', 'success', 'failure', 'rejected'], example: 'success' })
  state: string;

  @ApiProperty({
    type: 'string',
    example: '25.50000000',
    description: 'Credited, once it settled; until then, what was asked.',
  })
  amount: string;

  @ApiProperty({
    type: 'string',
    nullable: true,
    example: '30.00000000',
    description: 'What the link asked for, when the credited amount differs from it.',
  })
  requestedAmount: string | null;

  @ApiProperty({ example: 'USD' })
  currency: string;

  @ApiProperty({
    description:
      'Still open because a PERSON is checking it (money arrived the provider did not confirm, ' +
      'a figure it disputes) — not because nothing has arrived.',
  })
  underReview: boolean;
}

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
    description:
      'Always `pending`. Nothing is credited until the operator confirms receipt (manual method) ' +
      'or the provider confirms the payment (gateway method).',
    example: 'pending',
  })
  state: string;

  @ApiProperty({ format: 'date-time' })
  createdAt: string;

  @ApiProperty({
    type: 'string',
    nullable: true,
    example: 'https://whish.money/pay/8nQS2mL',
    description:
      "The provider's hosted payment page, for a GATEWAY method. Send the client there — they pay " +
      'on the provider’s own domain, and no card or OTP detail touches this system.\n\n' +
      'NULL for a manual method, where the client is shown `payTo` and instructions instead. A ' +
      'client MUST branch on this: assuming a link strands a bank-transfer client with nowhere to ' +
      'go, and assuming instructions shows a gateway client an account number that is not how ' +
      'that method works.',
  })
  paymentUrl: string | null;

  @ApiProperty({
    type: String,
    nullable: true,
    description:
      'When the hosted page stops accepting money (ISO), when the provider says — the waiting ' +
      'card’s countdown (0173). Null when unknown or for a manual method.',
  })
  paymentExpiresAt: string | null;

  @ApiProperty({
    description:
      'Whether the provider sends the payer back here after paying (0173). False (3pay) means: ' +
      'open `paymentUrl` in a new tab and keep the client on a live waiting card.',
  })
  returnsAfterPayment: boolean;

  @ApiProperty({
    type: String,
    nullable: true,
    example: 'USDT on Tron (TRC20)',
    description:
      'What to send when it is not the wallet currency — credited at par. Null when the ' +
      'client pays in the wallet currency itself.',
  })
  payWith: string | null;
}
