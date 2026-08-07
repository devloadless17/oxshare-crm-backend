import { ApiProperty } from '@nestjs/swagger';
import { tradingAccountStatusEnum, tradingEnvironmentEnum } from '../../../database/schema';

export const TRADING_ENVIRONMENTS = tradingEnvironmentEnum.enumValues;
export const TRADING_ACCOUNT_STATUSES = tradingAccountStatusEnum.enumValues;

export type TradingEnvironment = (typeof TRADING_ENVIRONMENTS)[number];
export type TradingAccountStatus = (typeof TRADING_ACCOUNT_STATUSES)[number];

/**
 * One trading account, as its OWNER sees it.
 *
 * ## Why this is not the admin DTO
 *
 * `admin/dto/responses.dto.ts` already carries a trading-account shape, and it
 * is deliberately not reused: that one joins the owning client's email and name
 * onto every row, because an operator is looking ACROSS clients and needs to
 * know whose account they are reading. Here the owner is the caller, so those
 * columns would be the client's own identity echoed back on every row — more
 * surface for no information.
 *
 * ## `balance` is the CRM's number, and the column comment says why that is
 * temporary
 *
 * `trading_accounts.balance` reverses an earlier decision to hold no balance at
 * all, and its schema comment is explicit that it exists only because there is
 * no MT5 bridge to hold it instead (ARCHITECTURE open decision #1). It is
 * therefore the honest figure TODAY — it is what a wallet→account transfer
 * actually credits — and it must become a mirror of MT5's balance, or
 * disappear, when the bridge lands.
 *
 * What is NOT here, and must not be added before that bridge exists: equity,
 * margin, free margin, open positions, floating P/L. Those are computed from
 * live prices against open trades, nothing in this database has them, and a
 * fabricated equity figure beside a real login is the most expensive kind of
 * wrong number on a trading product.
 *
 * §6.1: a decimal STRING, never a float.
 */
export class TradingAccountDto {
  @ApiProperty() id: string;

  @ApiProperty({
    type: 'string',
    nullable: true,
    description:
      'The MT5 login, once there is an MT5 to issue one. Null until a bridge assigns it — a ' +
      'string rather than a number because leading zeros are significant.',
  })
  login: string | null;

  @ApiProperty({ type: 'string', nullable: true })
  mt5Group: string | null;

  @ApiProperty({ enum: TRADING_ENVIRONMENTS })
  environment: TradingEnvironment;

  @ApiProperty({ description: "The account's own currency, which need not match the wallet's." })
  currency: string;

  @ApiProperty({
    type: 'string',
    example: '1250.00000000',
    description:
      'Decimal string (§6.1). The CRM-held balance — see the DTO note: this is what a transfer ' +
      'credits, and it becomes an MT5 mirror when the bridge lands. Not equity.',
  })
  balance: string;

  @ApiProperty({ type: 'string', nullable: true })
  tier: string | null;

  @ApiProperty({
    type: 'number',
    nullable: true,
    description: 'The leverage ratio denominator — 500 means 1:500. Null when unset.',
  })
  leverage: number | null;

  @ApiProperty({ enum: TRADING_ACCOUNT_STATUSES })
  status: TradingAccountStatus;

  @ApiProperty({ format: 'date-time' })
  createdAt: Date;
}
