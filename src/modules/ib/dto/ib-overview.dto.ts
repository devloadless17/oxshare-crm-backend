import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { WalletDto } from '../../wallet/dto/wallet-response.dto';

/**
 * The partner's own dashboard, in one response.
 *
 * ## What this deliberately does NOT invent
 *
 * Migration 0028 deleted the commission engine — `commission_accruals`, `deals`
 * and `ib_profiles` — and nothing has replaced it. There is therefore no
 * per-deal attribution, no volume, no lot count and no accrual anywhere in this
 * database, and this DTO carries none of those. A "$0.00 earned this month"
 * tile would be indistinguishable from a real zero, which is the same failure as
 * the wallet that rendered `$0.00` while the client held $700.
 *
 * What DOES exist is real and is reported here:
 *
 *  - `earnings` — summed from `ledger_entries` rows whose `entry_type` is
 *    commission, rebate or payout. Those types are already in the enum and the
 *    ledger is append-only, so this is a true total of what has actually been
 *    credited. It is zero for every partner today because nothing writes those
 *    rows yet, and `earningsEngineLive` says so explicitly rather than leaving
 *    the reader to guess whether zero means "nothing earned" or "nothing
 *    computed".
 *  - `referredClients` — from `users.referred_by_ib_user_id`, which IS written,
 *    at registration, by `AuthService`.
 *  - `subPartners` — from `ib_accounts.parent_ib_user_id`.
 *  - `level` — the partner's rung and its configured rate.
 *
 * ## `earningsEngineLive` is the honesty flag
 *
 * False means: the attribution and the ladder are real, and no engine has
 * computed a commission yet. A portal reading this must say so beside the
 * total instead of presenting a computed-looking zero. It flips to true when
 * something writes commission entries — at which point the same total becomes
 * a figure worth acting on, with no shape change here.
 */
export class IbEarningsDto {
  @ApiProperty({
    type: 'string',
    example: '0.00000000',
    description:
      'Lifetime credited earnings, as a decimal string (§6.1). Summed from ledger commission, ' +
      'rebate and payout entries — never computed on the fly.',
  })
  lifetime: string;

  @ApiProperty({
    type: 'string',
    example: '0.00000000',
    description: 'Credited in the last 30 days. Same source as `lifetime`.',
  })
  last30Days: string;

  @ApiProperty({
    description: 'The currency the totals are stated in.',
    example: 'USD',
  })
  currency: string;

  @ApiProperty({
    description:
      'FALSE means no commission engine has run — the totals are true but structurally zero, and ' +
      'must be labelled as such rather than shown as a computed result. See the DTO note.',
  })
  engineLive: boolean;
}

/**
 * The partner's COMMISSION wallets — where earnings are held until moved.
 *
 * ## Here rather than on its own endpoint, for the reason this whole DTO exists
 *
 * The commission BALANCE and the lifetime-earnings TOTAL sit beside each other
 * on one screen and are read as a pair. Fetched separately they can disagree —
 * the hourly confirm loop credits a commission between the two requests, and
 * the screen shows a balance that its own earnings figure does not explain.
 * Same instant, same response.
 *
 * ## Deliberately ABSENT from `GET /wallet`
 *
 * That endpoint returns `main` wallets only, and the exclusion is server-side
 * rather than a filter the portal applies. The wallet screen, the deposit
 * screen and the withdraw screen all read it, and none of them may offer a
 * commission wallet as a source: commission leaves through
 * `POST /ib/wallet/transfer` into the main wallet, and every other rail then
 * works on it unchanged. One filter in one UI would leave the other two to
 * remember the rule.
 *
 * ## EMPTY is the normal state, and it is not a zero
 *
 * The wallet is opened by the first commission credit, so a partner who has
 * never been paid has none. Render that as "nothing credited yet" — a zero
 * balance says money was earned and has gone, which is the same failure as the
 * wallet screen showing `$0.00` to a client holding $700.
 */
/** One client this partner introduced. */
export class IbReferredClientDto {
  @ApiProperty() userId: string;

  @ApiProperty({
    description:
      "The client's display name. Their EMAIL is deliberately absent — a partner is owed " +
      "attribution, not their referrals' contact details.",
  })
  name: string;

  @ApiProperty({
    description: 'Whether this client has completed identity verification.',
  })
  verified: boolean;

  @ApiProperty({ format: 'date-time', description: 'When they registered under the code.' })
  since: Date;
}

/** One partner sitting directly beneath this one. */
export class IbSubPartnerDto {
  @ApiProperty() userId: string;
  @ApiProperty() name: string;
  @ApiProperty({ example: 2 }) level: number;
  @ApiProperty({ description: 'A suspended sub-partner keeps their tree and stops earning.' })
  active: boolean;
  @ApiProperty({ format: 'date-time' }) since: Date;
}

/** The rung this partner stands on, and what it pays. */
export class IbLevelSummaryDto {
  @ApiProperty({ example: 1 }) level: number;
  @ApiProperty({ example: 'Master Partner' }) name: string;

  /*
   * `payoutModel` and `maxDirectPartners` went with migration 0055. The rate
   * has ONE unit now, so a client no longer has to read a second field before
   * it can render the first.
   */
  @ApiProperty({
    type: 'string',
    example: '70.0000',
    description:
      'The percentage of the broker’s revenue on a closed trade that this rung takes. A decimal ' +
      'string, never a number (§6.1).',
  })
  rateValue: string;
}

/**
 * Everything the partner area renders, in ONE request.
 *
 * One endpoint rather than five because these are read together on a single
 * screen and are meaningless apart — a referred-client count beside an earnings
 * total from a different instant is a screen that contradicts itself. It also
 * means the portal has one `AsyncBoundary` and one error state instead of five
 * panels failing independently.
 */
export class IbOverviewDto {
  @ApiProperty({ type: IbLevelSummaryDto, nullable: true })
  level: IbLevelSummaryDto | null;

  @ApiProperty({ type: IbEarningsDto })
  earnings: IbEarningsDto;

  /**
   * One entry per currency this partner has been paid in — see the note above
   * `IbReferredClientDto`. An empty array means nothing has been credited yet,
   * which is NOT the same as a zero balance.
   */
  @ApiProperty({ type: [WalletDto] })
  commissionWallets: WalletDto[];

  @ApiProperty({
    type: [IbReferredClientDto],
    description: 'Newest first. The whole list — a partner may read every client they introduced.',
  })
  referredClients: IbReferredClientDto[];

  @ApiProperty({ type: [IbSubPartnerDto], description: 'Partners directly beneath this one.' })
  subPartners: IbSubPartnerDto[];

  @ApiProperty({
    description: 'How many referred clients have completed KYC — the ones who can actually fund.',
  })
  verifiedReferredCount: number;
}

/**
 * One commission entry, as a partner reads it.
 *
 * ## `status` is the difference between a claim and money
 *
 * `pending` is earned and not yet payable — it is inside the maturation window
 * and no balance has moved. `confirmed` means it has been credited to the
 * wallet and the ledger entry exists. A table that showed only the amount
 * would let a partner add up a total they cannot spend, which is precisely the
 * confusion the two-step design exists to avoid.
 */
export class IbCommissionRowDto {
  @ApiProperty({ format: 'uuid' }) id: string;

  @ApiProperty({ description: 'The client whose activity earned it.' })
  clientName: string;

  @ApiProperty({
    enum: ['position', 'transaction'],
    description:
      'What produced it. `position` is a closed trade — the only source that pays a revenue ' +
      'share. `transaction` rows are historical: commission is no longer earned on deposits.',
  })
  source: string;

  @ApiProperty({
    description: "The base it was calculated from — the broker's revenue on the trade.",
  })
  baseAmount: string;

  @ApiProperty({ description: 'Percentage under revenue share; amount per lot under per-lot.' })
  rateValue: string;

  @ApiProperty() amount: string;
  @ApiProperty() currency: string;

  @ApiProperty({ enum: ['pending', 'confirmed', 'reversed'] })
  status: string;

  @ApiProperty({ description: "1 is a direct client; 2 is a sub-partner's client." })
  depth: number;

  @ApiProperty({ format: 'date-time' }) createdAt: Date;

  @ApiPropertyOptional({
    type: String,
    format: 'date-time',
    nullable: true,
    description: 'When it was credited. Null while it is still maturing.',
  })
  confirmedAt: Date | null;
}

/** One open trade belonging to a client this partner introduced. */
export class IbClientPositionDto {
  @ApiProperty({ format: 'uuid' }) id: string;
  @ApiProperty() clientName: string;
  @ApiProperty() symbol: string;
  @ApiProperty({ enum: ['buy', 'sell'] }) side: string;
  @ApiProperty({ description: 'Lots.' }) volume: string;
  @ApiProperty() openPrice: string;

  @ApiPropertyOptional({
    type: String,
    nullable: true,
    description:
      'Floating, and it moves. Shown because a partner asks "is my book alive", not so they can ' +
      'act on it — they have no control over a client’s trade.',
  })
  profit: string | null;

  @ApiProperty({ format: 'date-time' }) openedAt: Date;
}
