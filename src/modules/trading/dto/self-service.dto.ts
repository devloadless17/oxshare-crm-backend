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

  @ApiProperty({ example: 3, description: 'The most live accounts a client may hold.' })
  maxLiveAccounts: number;

  @ApiProperty({ example: 3, description: 'The most demo accounts a client may hold.' })
  maxDemoAccounts: number;

  @ApiProperty({
    type: 'string',
    example: '100000.00000000',
    description: 'The most a demo account may be funded with, as a decimal string (§6.1).',
  })
  maxDemoDeposit: string;
}
