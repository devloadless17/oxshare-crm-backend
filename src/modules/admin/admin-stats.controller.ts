// Part of the `admin` controller surface, split by concern — the same pattern
// admin-clients.controller.ts records. @ApiTags('admin') is repeated so Swagger
// groups every admin route under one tag and the generated frontend types stay
// in one namespace.

import { Controller, Get, Query, Req, UseGuards } from '@nestjs/common';
import { ApiCookieAuth, ApiOkResponse, ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';
import { Request } from 'express';
import { AdminStatsService, MAX_TREND_DAYS, DEFAULT_TREND_DAYS } from './admin-stats.service';
import {
  KycTrendSeriesDto,
  RegistrationSeriesDto,
  StatsOverviewDto,
  WithdrawalVolumeSeriesDto,
} from './dto/stats.dto';
import {
  PermissionsGuard,
  RequirePermissions,
  type AuthenticatedAdmin,
} from './guards/admin.guard';
import { ScopedToClients } from './guards/client-scope.decorator';
import { NotAudited } from './guards/audited.decorator';

/**
 * The admin dashboard's aggregates.
 *
 * ## Four narrow endpoints, not one fat one
 *
 * The three series are separate routes with their own permission because
 * partial permissions are the ordinary case, not the exception. A compliance
 * admin holding `kyc.review` and nothing else should be able to load the KYC
 * trend without also being granted sight of withdrawal volumes; folding all of
 * it into `/overview` would make the choice "grant everything or show nothing".
 *
 * `/overview` spans permissions because a dashboard's headline row does, and it
 * resolves that by OMITTING the sections the caller may not see rather than
 * refusing the request — see `StatsOverviewDto`, which documents the absent-vs-
 * zero contract the screens depend on.
 *
 * ## Every route is @ScopedToClients, and that is the load-bearing part
 *
 * Each number here is derived from client-owned rows, so each is a disclosure
 * about clients. A scoped administrator must see counts for THEIR clients only:
 * "219,000 clients" answered to somebody restricted to one desk leaks the size
 * and shape of a client base they were specifically denied, and it does it
 * through a screen nobody thinks of as a client list. `StatsStore` puts
 * `clientScopePredicate` in the WHERE clause of every query, never after the
 * fetch — an aggregate assembled in JavaScript over unscoped rows is precisely
 * the shape `common/security/client-scope.ts` forbids.
 *
 * ## Not audited
 *
 * All four are GETs of AGGREGATES: no client is named, no document is opened,
 * no PII crosses the wire. R-6.6 audits reads of a client's identity data; a
 * count of how many clients are pending is not that, and recording every
 * dashboard poll would bury the reads that matter under a log nobody can search.
 */
@ApiTags('admin')
@Controller('admin')
export class AdminStatsController {
  constructor(private readonly stats: AdminStatsService) {}

  @Get('stats/overview')
  @UseGuards(PermissionsGuard)
  /*
   * ANY ONE of the four admits the caller, and the SERVICE then decides what to
   * put in the response.
   *
   * The guard is deliberately the looser of the two checks. Requiring all four
   * here would 403 the dashboard for every admin holding a subset — which is
   * most of them — and requiring only `users.view` would make the route
   * unreachable for a compliance admin who legitimately has KYC numbers to see.
   * So the edge answers "may you ask at all" and
   * `AdminStatsService.SECTION_PERMISSIONS` answers "which numbers are yours",
   * per section, on the same permission keys.
   */
  @RequirePermissions('users.view', 'kyc.view', 'kyc.review', 'withdrawals.view', 'ib.view')
  @ApiCookieAuth()
  @ApiOperation({
    summary: 'Dashboard headline counters (clients, KYC, withdrawals, IB)',
    description:
      'Each section is gated on its own permission and is ABSENT when the caller lacks it — ' +
      'deliberately different from present-and-zero, so a screen can distinguish "hidden from ' +
      'you" from "there are none". `sections` lists what came back. Every counter is a real ' +
      'COUNT/SUM in SQL, restricted to the clients this administrator may see; `scoped` says ' +
      'whether that restriction is in force. Withdrawal amounts are STRINGS.',
  })
  @ApiOkResponse({ type: StatsOverviewDto })
  @ScopedToClients(
    'StatsStore.clientCounters/kycCounts/withdrawalTotals/ibCounts each apply ' +
      'clientScopePredicate in the WHERE clause, on users.id, kyc_submissions.user_id, ' +
      'transactions.user_id and ib_applications.user_id / ib_accounts.user_id respectively.',
  )
  @NotAudited(
    'A GET of aggregate counts. No client is named and no identity data is returned, so R-6.6 ' +
      'does not reach it; recording every dashboard poll would bury the PII reads that matter.',
  )
  getOverview(@Req() req: Request & { admin: AuthenticatedAdmin }) {
    return this.stats.overview(req.admin);
  }

  @Get('stats/registrations')
  @UseGuards(PermissionsGuard)
  @RequirePermissions('users.view')
  @ApiCookieAuth()
  @ApiOperation({
    summary: 'Registrations per day for the last N days',
    description:
      'Zero-filled: every calendar day in the window is present, and a day with no ' +
      'registrations comes back as 0 rather than being omitted. A chart fed only the days ' +
      'that have data draws the gaps closed and shows steady growth through an outage.',
  })
  @ApiOkResponse({ type: RegistrationSeriesDto })
  // `required: false` for the reason the client list records: without it Swagger
  // marks the parameter required and both frontends' generated types demand a
  // `days` on a call that legitimately omits it.
  @ApiQuery({
    name: 'days',
    required: false,
    schema: { type: 'integer', minimum: 1, maximum: MAX_TREND_DAYS, default: DEFAULT_TREND_DAYS },
    description: `Window length, 1–${MAX_TREND_DAYS}. Defaults to ${DEFAULT_TREND_DAYS}. An out-of-range or non-integer value is a 400 naming the range — never a silent clamp (R-2.5).`,
  })
  @ScopedToClients(
    'StatsStore.registrationsByDay applies clientScopePredicate to users.id inside the LEFT ' +
      'JOIN condition, so out-of-scope registrations never enter the daily counts.',
  )
  @NotAudited(
    'A GET of a daily count series. No client is identified in the response, so there is ' +
      'nothing here that R-6.6 asks to be attributable.',
  )
  getRegistrations(
    @Req() req: Request & { admin: AuthenticatedAdmin },
    @Query('days') days?: string,
  ) {
    return this.stats.registrations(days, req.admin);
  }

  @Get('stats/kyc-trend')
  @UseGuards(PermissionsGuard)
  // Either key: `kyc.view` sees the queue, `kyc.review` decides on it, and both
  // legitimately want the trend. The service asserts the same disjunction.
  @RequirePermissions('kyc.view', 'kyc.review')
  @ApiCookieAuth()
  @ApiOperation({
    summary: 'KYC submissions and approvals per day for the last N days',
    description:
      'Zero-filled like the registration series. `submitted` buckets on submitted_at and ' +
      '`approved` on reviewed_at where the status is approved — a submission made Monday and ' +
      'approved Thursday counts once in each, on its own day. A rejection reviewed that day ' +
      'is NOT counted as an approval.',
  })
  @ApiOkResponse({ type: KycTrendSeriesDto })
  @ApiQuery({
    name: 'days',
    required: false,
    schema: { type: 'integer', minimum: 1, maximum: MAX_TREND_DAYS, default: DEFAULT_TREND_DAYS },
    description: `Window length, 1–${MAX_TREND_DAYS}. Defaults to ${DEFAULT_TREND_DAYS}. Out of range is a 400 (R-2.5).`,
  })
  @ScopedToClients(
    'StatsStore.kycTrendByDay applies clientScopePredicate to kyc_submissions.user_id inside ' +
      'both correlated subqueries, so an out-of-scope submission is counted in neither.',
  )
  @NotAudited(
    'A GET of daily submission and approval counts. No submission, document or client is ' +
      'identified, so the R-6.6 rule about reading a client’s KYC record does not apply.',
  )
  getKycTrend(@Req() req: Request & { admin: AuthenticatedAdmin }, @Query('days') days?: string) {
    return this.stats.kycTrend(days, req.admin);
  }

  @Get('stats/withdrawal-volume')
  @UseGuards(PermissionsGuard)
  @RequirePermissions('withdrawals.view')
  @ApiCookieAuth()
  @ApiOperation({
    summary: 'Withdrawal amount and count per day for the last N days',
    description:
      'Zero-filled; a day with no withdrawals is `{count: 0, totalAmount: "0"}`. Amounts are ' +
      'STRINGS summed by Postgres over NUMERIC(28,8) and cast to text — never parsed into a ' +
      'JavaScript number anywhere on the path (ARCHITECTURE §6.1). Bucketed on when the ' +
      'withdrawal was requested, the only date defined for a pending or rejected one.',
  })
  @ApiOkResponse({ type: WithdrawalVolumeSeriesDto })
  @ApiQuery({
    name: 'days',
    required: false,
    schema: { type: 'integer', minimum: 1, maximum: MAX_TREND_DAYS, default: DEFAULT_TREND_DAYS },
    description: `Window length, 1–${MAX_TREND_DAYS}. Defaults to ${DEFAULT_TREND_DAYS}. Out of range is a 400 (R-2.5).`,
  })
  @ScopedToClients(
    'StatsStore.withdrawalVolumeByDay applies clientScopePredicate to transactions.user_id in ' +
      'the LEFT JOIN condition, so an out-of-scope withdrawal contributes to neither the count ' +
      'nor the summed amount.',
  )
  @NotAudited(
    'A GET of daily withdrawal totals. No transaction, client or destination is identified — ' +
      'the audited acts are the approve/reject/settle transitions, which are recorded inside ' +
      'the transaction that moves the money.',
  )
  getWithdrawalVolume(
    @Req() req: Request & { admin: AuthenticatedAdmin },
    @Query('days') days?: string,
  ) {
    return this.stats.withdrawalVolume(days, req.admin);
  }
}
