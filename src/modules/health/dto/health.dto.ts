import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

// Response DTOs so /api/docs-json carries these shapes and both frontends can
// generate types instead of hand-writing them (docs/API-CONTRACTS.md Part C).

const DEPENDENCY_STATES = ['up', 'down', 'not_configured'] as const;
export type DependencyState = (typeof DEPENDENCY_STATES)[number];

export class DependencyHealthDto {
  @ApiProperty({ example: 'postgres' })
  name: string;

  @ApiProperty({
    enum: DEPENDENCY_STATES,
    description:
      "'not_configured' is deliberately distinct from 'down': a dependency we have not wired yet is not a fault, but hiding it would make this endpoint claim a coverage it does not have.",
  })
  status: DependencyState;

  @ApiPropertyOptional({ description: 'Round-trip time in milliseconds.', example: 3 })
  latencyMs?: number;

  @ApiPropertyOptional({
    description: 'Why it is down. Never carries a connection string or credentials.',
  })
  detail?: string;

  @ApiProperty({
    description: 'Whether a failure here makes the whole instance unready (503).',
    example: true,
  })
  required: boolean;
}

export class LivenessDto {
  @ApiProperty({ example: 'ok' })
  status: 'ok';

  @ApiProperty({ example: '2026-08-04T10:13:00.563Z' })
  timestamp: string;

  @ApiProperty({ description: 'Seconds since the process started.', example: 1284 })
  uptimeSeconds: number;
}

export class ReadinessDto {
  @ApiProperty({
    enum: ['ready', 'not_ready'],
    description: "'not_ready' is served with HTTP 503 so a load balancer acts on it.",
  })
  status: 'ready' | 'not_ready';

  @ApiProperty({ example: '2026-08-04T10:13:00.563Z' })
  timestamp: string;

  @ApiProperty({ type: [DependencyHealthDto] })
  dependencies: DependencyHealthDto[];
}

export class EdgeDto {
  @ApiProperty({
    nullable: true,
    type: String,
    example: '94.187.15.248',
    description:
      "The caller's address as the API resolved it: what the rate limiter, the admin network allowlist and the audit trail use. It must equal the caller's public address.",
  })
  address: string | null;

  @ApiProperty({
    nullable: true,
    type: Boolean,
    description:
      'Whether the machine that connected to Caddy is a trusted proxy (a CDN whose ranges are in `trusted_proxies`). `false` for a direct connection. `null` when Caddy was not in the path.',
  })
  peerTrusted: boolean | null;

  @ApiProperty({
    description:
      'The X-Forwarded-For the request arrived with, before Caddy replaced it. Empty for a direct browser request.',
    example: '94.187.15.248',
  })
  forwardedChain: string;

  @ApiProperty({
    type: [String],
    description:
      'Headers on this request that only a proxy adds. Any of these with `peerTrusted: false` means a proxy stands in front that Caddy does not trust.',
    example: ['x-forwarded-for', 'cdn-loop', 'cf-connecting-ip'],
  })
  proxyHeaders: string[];
}
