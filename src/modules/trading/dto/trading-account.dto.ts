import { ApiProperty } from '@nestjs/swagger';

const ENVIRONMENTS = ['live', 'demo'] as const;

/**
 * One MT5 trading account, as the owning client sees it.
 *
 * ## What is deliberately absent
 *
 * No balance, equity, margin or open positions. Those live in MT5, not in this
 * database — `trading_accounts` holds the CRM's record of which logins belong to
 * whom, and nothing here has ever been the authority on what is in one. Adding
 * a `balance` column to this DTO would have to invent it, and a fabricated
 * figure beside a real MT5 login is the most expensive kind of wrong number on
 * a trading product. They arrive when the MT5 bridge does.
 *
 * ## Every field is one the CRM actually owns
 *
 * `mt5Login`, `mt5Group`, `environment`, `tier` and `leverage` are all columns
 * on `trading_accounts` — written by the provisioning path and by the MT5
 * webhook. This DTO is a projection of the row, not a composition, which is why
 * it can be trusted without a single call out to the bridge.
 *
 * Declared as a DTO with `@ApiProperty` rather than left to inference because
 * the portal aliases `components['schemas']` from the generated OpenAPI: a
 * handler with no `@ApiOkResponse` generates as `content?: never`, and the
 * client then hand-writes the shape and gets it wrong. That is exactly the drift
 * `WalletDto` was introduced to stop.
 */
export class TradingAccountDto {
  @ApiProperty() id: string;

  @ApiProperty({
    example: '5001234',
    description:
      'The MT5 login. A string, not a number — it is an identifier that happens to be digits, ' +
      'and leading zeros are significant to the bridge.',
  })
  mt5Login: string;

  /*
   * `type: 'string'` is spelled out on every nullable property below, and it is
   * load-bearing rather than noise. `@ApiProperty({ nullable: true })` alone
   * emits a schema with no `type`, which openapi-typescript renders as
   * `Record<string, never> | null` — so the portal aliasing this DTO got an
   * empty object where it expected a string, and only found out at the call
   * site. Declaring the type keeps the generated alias honest.
   */
  @ApiProperty({
    type: 'string',
    nullable: true,
    example: 'real\\Standard',
    description: 'The MT5 group this account sits in. Null until the bridge reports one.',
  })
  mt5Group: string | null;

  @ApiProperty({
    enum: ENVIRONMENTS,
    description:
      'Whether this is real money or a practice account. The client-facing distinction that ' +
      'matters most on this screen: a demo account must never be mistaken for a live one.',
  })
  environment: (typeof ENVIRONMENTS)[number];

  @ApiProperty({ type: 'string', nullable: true, example: 'Standard' })
  tier: string | null;

  @ApiProperty({ type: 'number', nullable: true, example: 500, description: 'The 1:N in 1:500.' })
  leverage: number | null;

  @ApiProperty()
  createdAt: Date;
}
