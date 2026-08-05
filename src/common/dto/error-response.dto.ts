import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

/**
 * The one error envelope, as a schema the frontends can generate from — R-2.2.
 *
 * `AllExceptionsFilter` has emitted this shape for a while, and both frontends
 * hand-wrote their own picture of it because there was nothing to alias: the
 * filter is not a route handler, so nothing put it into the OpenAPI document.
 * That is R-1.1's exception proving its own rule — a renamed `requestId` would
 * compile clean in both apps and silently degrade every error to a fallback
 * string.
 *
 * The consequence was worse in the portal, which had no machine-readable signal
 * to branch on and matched the ENGLISH TEXT of a message instead
 * (`login/page.tsx`: `.includes('verify your email')`). That breaks twice over —
 * when the message is reworded, and on the day Arabic ships, which FSD §10 and
 * D-16 require. `code` exists so a client never has to read prose to make a
 * decision.
 *
 * Registered through `extraModels`, because no handler returns it.
 */
export class ErrorResponseDto {
  @ApiProperty({ example: 403, description: 'HTTP status, repeated in the body for convenience.' })
  statusCode!: number;

  @ApiProperty({
    example: 'EMAIL_NOT_VERIFIED',
    description:
      'Machine-readable cause, from a closed set. BRANCH ON THIS, never on `message` — the ' +
      'message is prose, is localised, and is reworded without notice.',
  })
  code!: string;

  @ApiProperty({
    example: 'Please verify your email address before accessing this resource.',
    description: 'Human-readable and safe to display. Never parse it.',
  })
  message!: string;

  @ApiPropertyOptional({
    type: 'object',
    additionalProperties: { type: 'string' },
    example: { amount: 'must not be less than 10' },
    description:
      'Present only on validation failures: field path → what is wrong with it. Dotted for ' +
      'nested DTOs, so a form can attach each message to the input that caused it.',
  })
  fields?: Record<string, string>;

  @ApiProperty({
    example: 'req-lz4k2p-8f3a91c2',
    description:
      'The correlation id for this request (R-6.1). Stamped on every log line the API wrote ' +
      'while handling it, so quoting it in a support ticket is enough to find them.',
  })
  requestId!: string;

  @ApiProperty({ example: '2026-08-05T13:45:12.000Z', description: 'ISO-8601 UTC (R-2.7).' })
  timestamp!: string;

  @ApiProperty({
    example: '/v1/payments/withdrawals',
    description: 'The path as served, with query values redacted.',
  })
  path!: string;
}
