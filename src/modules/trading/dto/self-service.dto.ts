import { ApiProperty } from '@nestjs/swagger';

/**
 * The response of `GET /trading/accounts/self-service` — what THIS client may
 * open (3 Oct 2026).
 *
 * The route declared no response type until then, so the portal's generated
 * types knew nothing of `productAr` and it had to be read untyped. These classes
 * describe the runtime shape exactly as `TradingController.selfService` builds
 * it; nothing about the response changed.
 */
export class SelfServiceAccountTypeDto {
  @ApiProperty({
    example: 'real\\standard-usd',
    description: 'The MT5 group the account opens in.',
  })
  group: string;

  @ApiProperty({
    example: 'USD',
    description:
      'The group’s currency, read live from MT5 — the cached catalogue copy when MT5 cannot say.',
  })
  currency: string;

  @ApiProperty({
    example: 'Standard',
    description: 'The product’s name, as the client is offered it.',
  })
  product: string;

  @ApiProperty({
    type: String,
    nullable: true,
    example: 'قياسي',
    description: 'The product’s name in Arabic (0179); null = not translated, show `product`.',
  })
  productAr: string | null;

  @ApiProperty({
    format: 'uuid',
    description:
      'Sent back on create (0142): a group may back several products, so the product is what ' +
      'identifies which offer the client picked.',
  })
  productId: string;

  @ApiProperty({
    example: 5,
    description: 'How many accounts one client may hold under this product (0201).',
  })
  maxAccounts: number;

  @ApiProperty({
    example: 1,
    description:
      'How many this client holds under the product now, closed ones excluded — at ' +
      '`maxAccounts` the product cannot be opened again.',
  })
  heldAccounts: number;

  @ApiProperty({
    type: 'string',
    nullable: true,
    example: '100.00000000',
    description:
      'The least the client may move into an account of this type per transfer, in its ' +
      'currency, as a decimal string (§6.1). Null = no minimum; always null on demo.',
  })
  minDeposit: string | null;
}

export class SelfServiceOfferDto {
  @ApiProperty({ description: 'This client has at least one live account type to open.' })
  live: boolean;

  @ApiProperty({ description: 'This client has at least one demo account type to open.' })
  demo: boolean;

  @ApiProperty({ type: [SelfServiceAccountTypeDto] })
  liveTypes: SelfServiceAccountTypeDto[];

  @ApiProperty({ type: [SelfServiceAccountTypeDto] })
  demoTypes: SelfServiceAccountTypeDto[];

  @ApiProperty({
    type: [Number],
    example: [50, 100, 200, 500],
    description: 'The enabled leverage ladder — 500 means 1:500.',
  })
  leverages: number[];

  // `maxDemoDeposit` was here — the demo ceiling was removed (owner, 7 Oct 2026; 0205).
}
