import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  ibApplicationStatusEnum,
  kycStatusEnum,
  transactionStateEnum,
} from '../../../database/schema';

/*
 * Response DTOs for the dashboard aggregates.
 *
 * `@ApiProperty` on every field is not decoration: both frontends generate
 * their TypeScript from `/api/docs-json`, so a field without one is a field the
 * admin app cannot see and will hand-write an interface for instead — which is
 * exactly the mechanism that turns backend drift into a compile error, removed.
 *
 * The enum-keyed maps below are declared as `additionalProperties` rather than
 * as one property per enum value, deliberately. The KYC statuses and the
 * transaction states come from `database/schema.ts`, and enumerating them here
 * would be a hand-copy that is right on the day it is written and silently
 * wrong the day somebody adds a state. `enum:` on the KEY documents the
 * vocabulary without pinning a copy of it.
 */

/** Clients registered inside each rolling window. Every count scoped to the actor. */
export class ClientRegistrationWindowDto {
  @ApiProperty({ description: 'Registered since midnight UTC today.' })
  today: number;

  @ApiProperty({ description: 'Registered since the start of the current ISO week (UTC).' })
  thisWeek: number;

  @ApiProperty({ description: 'Registered since the first of the current month (UTC).' })
  thisMonth: number;
}

export class ClientStatusCountsDto {
  @ApiProperty() active: number;
  @ApiProperty() pending: number;
  @ApiProperty() suspended: number;
}

/**
 * `users.verification_level`: 0 is not verified, 1 is verified.
 *
 * Two buckets rather than a level-keyed map, because the column is a gate and
 * not a scale — level 1 is what opens withdrawals. If a level 2 is ever added,
 * this DTO has to change, and that is the right amount of friction for a change
 * that alters what "verified" means on a compliance screen.
 */
export class ClientVerificationCountsDto {
  @ApiProperty({ description: 'verification_level >= 1.' }) verified: number;
  @ApiProperty({ description: 'verification_level < 1.' }) notVerified: number;
}

export class ClientStatsDto {
  @ApiProperty({ description: 'Every client visible to the calling admin.' })
  total: number;

  @ApiProperty({ type: ClientRegistrationWindowDto })
  registered: ClientRegistrationWindowDto;

  @ApiProperty({ type: ClientStatusCountsDto })
  byStatus: ClientStatusCountsDto;

  @ApiProperty({ type: ClientVerificationCountsDto })
  byVerification: ClientVerificationCountsDto;
}

export class KycStatsDto {
  @ApiProperty({
    description:
      `Submission count per kyc_status (${kycStatusEnum.enumValues.join(', ')}). ALL of them ` +
      'are always present; a status with no submissions is 0, never absent — absent and zero ' +
      'look identical to a chart and mean opposite things to a reviewer.',
    type: 'object',
    additionalProperties: { type: 'number' },
    // Interpolated from the schema enum rather than hand-listed, so a status
    // added to `database/schema.ts` shows up here with no second edit. A copied
    // array is right on the day it is written and quietly wrong afterwards.
    example: Object.fromEntries(kycStatusEnum.enumValues.map((status) => [status, 0])),
  })
  /*
   * `Record<string, number>` and not a union of the six enum values.
   *
   * `Record<KycStatus | string, …>` collapses to `Record<string, …>` anyway —
   * the union adds no checking, only the appearance of it. Keying strictly on
   * `KycStatus` would be a real narrowing, and is wrong here: the keys are
   * produced by a GROUP BY over a Postgres enum, so the day a seventh status is
   * added the query returns it and a `Record<KycStatus, …>` would be a lie the
   * compiler believes. The `enum` in the schema is the vocabulary; the DTO's job
   * is to say the shape is a count per status, which `additionalProperties`
   * above does for the generated frontend types.
   */
  byStatus: Record<string, number>;
}

export class WithdrawalStateTotalDto {
  @ApiProperty({ enum: transactionStateEnum.enumValues })
  state: string;

  @ApiProperty() count: number;

  @ApiProperty({
    type: 'string',
    example: '12500.00000000',
    description:
      'Monetary value — ALWAYS a string, never a number. NUMERIC(28,8) at rest; ' +
      'Number()/parseFloat on this field truncates past 2^53 (ARCHITECTURE §6.1).',
  })
  totalAmount: string;
}

export class WithdrawalStatsDto {
  @ApiProperty({
    type: [WithdrawalStateTotalDto],
    description:
      'One entry per transaction_state, always all of them, covering withdrawals only ' +
      '(direction = withdrawal). Deposits are excluded.',
  })
  byState: WithdrawalStateTotalDto[];
}

export class IbStatsDto {
  @ApiProperty({
    description:
      `Application count per ib_application_status ` +
      `(${ibApplicationStatusEnum.enumValues.join(', ')}). All values always present.`,
    type: 'object',
    additionalProperties: { type: 'number' },
    example: Object.fromEntries(ibApplicationStatusEnum.enumValues.map((s) => [s, 0])),
  })
  /** A count per ib_application_status — see the note on `KycStatsDto.byStatus`. */
  applications: Record<string, number>;

  @ApiProperty({ description: 'Rows in ib_accounts — partners on the books, active or not.' })
  partners: number;
}

/**
 * The dashboard headline.
 *
 * ## Every section is OPTIONAL, and that is the contract
 *
 * A section is ABSENT when the caller lacks the permission its data requires —
 * `clients` needs `users.view`, `kyc` needs `kyc.view` or `kyc.review`,
 * `withdrawals` needs `withdrawals.view`, `ib` needs `ib.view`. Absent, not
 * zeroed: a KYC tile reading "0 pending" to an admin who simply may not see KYC
 * is a confident lie, and it is the sort a screen renders for months before
 * anyone questions it. A screen must treat `undefined` as "not yours to see"
 * and render nothing, which is distinguishable from a real zero.
 *
 * Which sections came back is also stated positively in `sections`, so a client
 * does not have to infer permission from the shape of an object.
 *
 * Requiring all four permissions for one endpoint was the alternative and is
 * worse: it makes the dashboard useless to every admin holding a subset, which
 * is most of them. The narrow per-section endpoints (`/stats/registrations`,
 * `/stats/kyc-trend`, `/stats/withdrawal-volume`) exist so a partial-permission
 * admin can still load the charts they are entitled to.
 */
export class StatsOverviewDto {
  @ApiPropertyOptional({
    type: ClientStatsDto,
    description: 'Present only with users.view. ABSENT — not zeroed — otherwise.',
  })
  clients?: ClientStatsDto;

  @ApiPropertyOptional({
    type: KycStatsDto,
    description: 'Present only with kyc.view or kyc.review. ABSENT otherwise.',
  })
  kyc?: KycStatsDto;

  @ApiPropertyOptional({
    type: WithdrawalStatsDto,
    description: 'Present only with withdrawals.view. ABSENT otherwise.',
  })
  withdrawals?: WithdrawalStatsDto;

  @ApiPropertyOptional({
    type: IbStatsDto,
    description: 'Present only with ib.view. ABSENT otherwise.',
  })
  ib?: IbStatsDto;

  @ApiProperty({
    type: [String],
    description:
      'The sections this response actually carries, so a screen reads a list rather than ' +
      'probing for undefined keys.',
    example: ['clients', 'kyc'],
  })
  sections: string[];

  @ApiProperty({
    description:
      'True when the calling admin is restricted to a subset of clients, in which case every ' +
      'number above counts only THEIR clients. A screen showing a headline total to a scoped ' +
      'admin without saying so invites it to be read as a platform total.',
  })
  scoped: boolean;
}

/*
 * ── The time series ─────────────────────────────────────────────────────────
 *
 * All three share a shape: a `days` echo, and a dense array with one entry per
 * calendar day INCLUDING days with nothing in them.
 *
 * The zero-fill is a promise the API makes, not a convenience. A chart handed
 * only the days that have data draws the gaps closed, so a week of downtime
 * renders as a straight line between the days either side and the operator sees
 * steady activity through an outage. `store/stats.store.ts` fills in SQL with
 * `generate_series` so the shape is right at the source.
 */

export class RegistrationPointDto {
  @ApiProperty({ example: '2026-08-01', description: 'UTC calendar day, YYYY-MM-DD.' })
  date: string;

  @ApiProperty({ description: 'Registrations that day. 0 for a day with none — never omitted.' })
  count: number;
}

export class RegistrationSeriesDto {
  @ApiProperty({ description: 'The window actually served, echoed back.' })
  days: number;

  @ApiProperty({
    type: [RegistrationPointDto],
    description: 'Exactly `days` entries, oldest first, one per calendar day with no gaps.',
  })
  points: RegistrationPointDto[];

  @ApiProperty({ description: 'True when these counts cover only the actor’s own clients.' })
  scoped: boolean;
}

export class KycTrendPointDto {
  @ApiProperty({ example: '2026-08-01' }) date: string;

  @ApiProperty({ description: 'Submissions whose submitted_at falls on this day.' })
  submitted: number;

  @ApiProperty({
    description:
      'Submissions REVIEWED on this day whose status is approved. A rejection reviewed the ' +
      'same day is not counted here.',
  })
  approved: number;
}

export class KycTrendSeriesDto {
  @ApiProperty() days: number;

  @ApiProperty({ type: [KycTrendPointDto], description: 'Exactly `days` entries, no gaps.' })
  points: KycTrendPointDto[];

  @ApiProperty() scoped: boolean;
}

export class WithdrawalVolumePointDto {
  @ApiProperty({ example: '2026-08-01' }) date: string;

  @ApiProperty({ description: 'Withdrawal requests created that day.' })
  count: number;

  @ApiProperty({
    type: 'string',
    example: '4200.50000000',
    description:
      'Monetary value — ALWAYS a string, never a number (§6.1). "0" for a day with no ' +
      'withdrawals, never null.',
  })
  totalAmount: string;
}

export class WithdrawalVolumeSeriesDto {
  @ApiProperty() days: number;

  @ApiProperty({
    type: [WithdrawalVolumePointDto],
    description:
      'Exactly `days` entries, no gaps. Bucketed on when the withdrawal was REQUESTED ' +
      '(created_at), which is the only date defined for a pending or rejected request.',
  })
  points: WithdrawalVolumePointDto[];

  @ApiProperty() scoped: boolean;
}
