import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

/**
 * Response shapes for the MT5 bridge's diagnostics — see
 * `admin-bridge.controller.ts`.
 *
 * Declared as DTOs rather than passed through untyped so the admin app's
 * generated `types.gen.ts` describes them. A passthrough endpoint is exactly
 * where an untyped `any` survives longest: nothing here fails at compile time,
 * so the screen silently renders `undefined` when a field is renamed upstream.
 *
 * ⚠️ Every nullable property declares `type` EXPLICITLY. Nest cannot read
 * `string | null` off the TypeScript annotation — a union erases to Object — so
 * `@ApiProperty({ nullable: true })` alone emits a schema carrying no type, and
 * `openapi-typescript` renders it as `Record<string, never> | null`. The admin
 * then fails to compile on every use of that field.
 */

class BridgeOutboxSummaryDto {
  @ApiProperty({ example: 12 })
  total!: number;

  @ApiProperty({ example: 12 })
  delivered!: number;

  @ApiProperty({
    description: 'Not yet delivered. Includes rows that are simply new.',
    example: 0,
  })
  pending!: number;

  @ApiProperty({
    description:
      'Undelivered AND already attempted — this API is rejecting them. This is the number ' +
      'worth alerting on; `pending` alone cries wolf on a healthy busy system.',
    example: 0,
  })
  failing!: number;
}

class BridgeOutboxRowDto {
  @ApiProperty({
    description: "MT5's ticket, as a string — it is a 64-bit id and JavaScript rounds those.",
    example: '56054592',
  })
  dealId!: string;

  @ApiProperty({
    description:
      "How the bridge learned of it. Always 'sweep' on this protocol — the MT5 Web API has no deal push.",
    example: 'sweep',
  })
  source!: string;

  @ApiProperty({ example: 0 })
  attempts!: number;

  @ApiProperty({
    description:
      'When delivery will next be tried. Far in the future on an undelivered row means the ' +
      'queue is backing off, not stuck.',
  })
  nextAttempt!: string;

  @ApiProperty({
    type: String,
    nullable: true,
    description:
      'Null while undelivered. This field answers "did it arrive"; the value answers "when".',
  })
  deliveredAt!: string | null;

  @ApiProperty({ type: String, nullable: true, example: 'HTTP 400: VALIDATION_FAILED ...' })
  lastError!: string | null;

  @ApiProperty()
  createdAt!: string;
}

export class BridgeOutboxDto {
  @ApiProperty({ type: BridgeOutboxSummaryDto })
  summary!: BridgeOutboxSummaryDto;

  @ApiProperty({ type: [BridgeOutboxRowDto] })
  rows!: BridgeOutboxRowDto[];
}

class BridgeOperationsSummaryDto {
  @ApiProperty({ example: 19 })
  total!: number;

  @ApiProperty({ example: 19 })
  completed!: number;

  @ApiProperty({
    description:
      'Claimed but never confirmed — the bridge told MT5 to move money and never learned ' +
      'whether it did. Any non-zero value needs a person, not a timer.',
    example: 0,
  })
  stuck!: number;
}

class BridgeOperationRowDto {
  @ApiProperty({
    description: "The CRM's own transfer id, which is how this row joins back to a transaction.",
    example: 'fb2e201a-5752-422c-a8c8-b43a228471dc',
  })
  idempotencyKey!: string;

  @ApiProperty({ example: '6477978' })
  login!: string;

  @ApiProperty({
    description:
      'A decimal STRING (§6.1), exactly as stored. Never a number — this is money on a screen ' +
      "somebody checks a client's balance against.",
    example: '1000.00000000',
  })
  amount!: string;

  @ApiProperty({
    description:
      "MT5's operation type. `balance` is real money; `credit` is broker funds the client cannot withdraw.",
    example: 'balance',
  })
  type!: string;

  @ApiProperty({
    type: String,
    nullable: true,
    description: 'The resulting MT5 ticket. Null means the operation never confirmed.',
    example: '56054592',
  })
  dealId!: string | null;

  @ApiProperty()
  startedAt!: string;

  @ApiProperty({
    type: String,
    nullable: true,
    description: 'Null is the state that needs a human: claimed, and never confirmed.',
  })
  completedAt!: string | null;
}

export class BridgeOperationsDto {
  @ApiProperty({ type: BridgeOperationsSummaryDto })
  summary!: BridgeOperationsSummaryDto;

  @ApiProperty({ type: [BridgeOperationRowDto] })
  rows!: BridgeOperationRowDto[];
}

export class BridgeLogsDto {
  @ApiProperty({
    description: 'The file that was read, named even when absent so the next guess is informed.',
    example: 'C:\\bridge\\logs\\bridge-20260815.log',
  })
  file!: string;

  @ApiProperty({
    description: 'False is a normal answer on the first run of a day, not an error.',
  })
  exists!: boolean;

  @ApiPropertyOptional({
    description: 'How many lines matched before the tail was taken.',
    example: 1284,
  })
  matched?: number;

  @ApiProperty({ type: [String] })
  lines!: string[];
}
