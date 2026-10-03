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
 * ## `tier` is GONE, and it was never a field
 *
 * `trading_accounts.tier` is a column NOTHING has ever written. It was on this
 * DTO and therefore on the portal's account card, which rendered it as "TYPE —"
 * on every account of every client: a permanent em dash where a value belongs.
 *
 * That is the same failure as a hardcoded `$0.00` on the wallet, in a smaller
 * denomination — a field that always reads "unknown" teaches a client that the
 * data is missing rather than that the field is meaningless, and it is the first
 * thing they ask support about. `product` above is the real answer to the
 * question "what kind of account is this", so the placeholder is removed rather
 * than left beside it.
 *
 * The COLUMN stays, and is now read by NOTHING. Admin's holdings projection and
 * the trading-account CSV selected it until they were switched to `product`,
 * where it was a `Tier` header above a column of blanks on every export anybody
 * ever ran. Dropping the column is a migration with no benefit and the one
 * direction that cannot be undone; it is labelled inert in `schema.ts` instead.
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

  @ApiProperty({
    type: 'string',
    nullable: true,
    description:
      'What the client calls this account. NULL means unnamed — the portal falls back to the ' +
      'login rather than inventing a name, so an account somebody named "5001234" stays ' +
      'distinguishable from one nobody named at all.',
  })
  name: string | null;

  @ApiProperty({
    type: 'string',
    nullable: true,
    description:
      'The MT5 group path this account sits in — a server path, not a label. Null on accounts ' +
      'opened before it was persisted; see `product`, which is the readable form and what a ' +
      'client is shown.',
  })
  mt5Group: string | null;

  @ApiProperty({
    type: 'string',
    nullable: true,
    example: 'Standard',
    description:
      'The product this account was opened under. Read from its own `productId` column, ' +
      'which is SNAPSHOTTED at creation (migration 0080) so that re-pointing a group in the ' +
      'catalogue afterwards cannot retroactively change what an existing account was sold as; ' +
      'accounts opened before 0080 fall back to matching `mt5Group` against ' +
      '`trading_product_groups`. Null when neither answers — an operator may open an account ' +
      'directly into any MT5 group, including one the catalogue does not sell. THE PORTAL ' +
      'RENDERS THIS, not the group: a backslash-separated MT5 group path is unreadable to a ' +
      'client, which is why the open-account form asks for a currency and a product.',
  })
  product: string | null;

  @ApiProperty({
    type: 'string',
    nullable: true,
    example: 'قياسي',
    description:
      "The same product's name in Arabic (0179), from the same catalogue row as `product`. " +
      'Null when untranslated or when there is no product — show `product`.',
  })
  productAr: string | null;

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
