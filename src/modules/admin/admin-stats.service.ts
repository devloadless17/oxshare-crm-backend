import { Injectable } from '@nestjs/common';
import { StatsStore } from '../../store/stats.store';
import { ValidationError } from '../../common/errors/domain-errors';
import { actorHasPermission, assertActorCan } from '../../common/security/actor';
import type { AuthenticatedAdmin } from './guards/admin.guard';
import type {
  KycTrendSeriesDto,
  RegistrationSeriesDto,
  StatsOverviewDto,
  WithdrawalVolumeSeriesDto,
} from './dto/stats.dto';

/**
 * The admin dashboard's numbers (ADM — headline counters and trends).
 *
 * ## Two rules govern everything in this file
 *
 * **1. Every aggregate is scoped.** `actor.clientScope` goes into every store
 * call, and the store puts it in the WHERE clause. A dashboard that answered
 * "219,000 clients" to an administrator restricted to one desk's territory
 * would be a data leak with no error anywhere and no row to point at — the
 * exact failure `common/security/client-scope.ts` was built to make impossible,
 * arriving through a screen nobody thought of as a client list. A COUNT is a
 * disclosure.
 *
 * **2. Every section is gated on the permission its underlying data requires,
 * and asserted HERE as well as at the guard.** R-4.3: the guard runs on an HTTP
 * request, and this method is what a queued report job would call. The overview
 * therefore does not assert-or-throw per section — it CHECKS and OMITS, because
 * an admin holding `clients.view` but not `kyc.review` should get a working
 * dashboard with the client tiles on it, not a 403 for the whole screen.
 *
 * ## Why the overview omits rather than zeroes
 *
 * A missing section and a zeroed one are different claims. "0 pending KYC" shown
 * to somebody who may not see KYC at all is a confident lie that renders
 * identically to the truth, and a compliance screen is the worst place to put
 * one. The narrow series endpoints below take the other branch and refuse
 * outright, because there the whole response IS the gated data.
 */
@Injectable()
export class AdminStatsService {
  /**
   * The permission each overview section needs. Any ONE of the listed keys is
   * enough, matching `@RequirePermissions` semantics at the edge.
   *
   * A table rather than four inline `if`s, so "which permission covers which
   * numbers" is one readable list — the thing a reviewer actually wants to check
   * — instead of a property of control flow spread down a method.
   */
  private static readonly SECTION_PERMISSIONS = {
    clients: ['clients.view'],
    kyc: ['kyc.view', 'kyc.review'],
    withdrawals: ['withdrawals.view'],
    ib: ['ib.view'],
  } as const;

  constructor(private readonly stats: StatsStore) {}

  /**
   * Headline counters, restricted to the sections this actor may see.
   *
   * Every included section's queries run concurrently — they are independent
   * reads and serialising them would make the slowest screen in the product
   * four round trips deep for no reason.
   */
  async overview(actor: AuthenticatedAdmin): Promise<StatsOverviewDto> {
    /*
     * R-4.3 at the top, and it is not redundant with the per-section checks
     * below.
     *
     * The route guard requires ANY of the four permissions, so an actor reaching
     * here holds at least one. This states the floor at the service layer too,
     * for the caller that is not an HTTP request — a scheduled digest, a report
     * job — where no guard ran at all. Without it, such a caller could pass an
     * actor with no permissions whatsoever and receive a response; it would be
     * an empty one, which is harmless today and is exactly the kind of "harmless
     * today" that stops being true when a fifth section is added and somebody
     * forgets its check.
     */
    const may = (section: keyof typeof AdminStatsService.SECTION_PERMISSIONS): boolean =>
      AdminStatsService.SECTION_PERMISSIONS[section].some((key) => actorHasPermission(actor, key));

    const wanted = (
      Object.keys(
        AdminStatsService.SECTION_PERMISSIONS,
      ) as (keyof typeof AdminStatsService.SECTION_PERMISSIONS)[]
    ).filter(may);

    if (wanted.length === 0) {
      // Names one of the keys rather than all four: the message is read by a
      // person deciding what to grant, and "requires clients.view" is actionable
      // where "requires one of four things" is a puzzle.
      assertActorCan(actor, 'clients.view', 'view the dashboard overview');
    }

    const scope = actor.clientScope;

    const [clients, kyc, withdrawals, ib] = await Promise.all([
      may('clients') ? this.stats.clientCounters(scope) : undefined,
      may('kyc') ? this.stats.kycCounts(scope) : undefined,
      may('withdrawals') ? this.stats.withdrawalTotals(scope) : undefined,
      may('ib') ? this.stats.ibCounts(scope) : undefined,
    ]);

    return {
      clients: clients
        ? {
            total: clients.total,
            registered: {
              today: clients.registeredToday,
              thisWeek: clients.registeredThisWeek,
              thisMonth: clients.registeredThisMonth,
            },
            byStatus: clients.byStatus,
            byVerification: clients.byVerification,
          }
        : undefined,
      kyc: kyc ? { byStatus: kyc } : undefined,
      // The store already returns amounts as strings. Nothing here touches them
      // — no Number(), no toFixed, no formatting (§6.1). Formatting is the
      // frontend's job and it has the currency's precision to do it with.
      withdrawals: withdrawals ? { byState: withdrawals } : undefined,
      ib: ib ? { applications: ib.applications, partners: ib.partners } : undefined,
      sections: wanted,
      scoped: !scope.unrestricted,
    };
  }

  async registrations(
    days: string | undefined,
    actor: AuthenticatedAdmin,
  ): Promise<RegistrationSeriesDto> {
    assertActorCan(actor, 'clients.view', 'view the registration trend');
    const window = parseDays(days);

    return {
      days: window,
      points: await this.stats.registrationsByDay(actor.clientScope, window),
      scoped: !actor.clientScope.unrestricted,
    };
  }

  async kycTrend(days: string | undefined, actor: AuthenticatedAdmin): Promise<KycTrendSeriesDto> {
    /*
     * `kyc.view` OR `kyc.review`, matching the route and matching the overview's
     * table. `assertActorCan` takes one key, so the disjunction is written out
     * here rather than smuggled into the helper — a variant that accepted a list
     * would be one more thing that can disagree with the guard, and the two
     * disagreeing is precisely the failure R-4.5 was written about.
     */
    if (!actorHasPermission(actor, 'kyc.view')) {
      assertActorCan(actor, 'kyc.review', 'view the KYC trend');
    }
    const window = parseDays(days);

    return {
      days: window,
      points: await this.stats.kycTrendByDay(actor.clientScope, window),
      scoped: !actor.clientScope.unrestricted,
    };
  }

  async withdrawalVolume(
    days: string | undefined,
    actor: AuthenticatedAdmin,
  ): Promise<WithdrawalVolumeSeriesDto> {
    assertActorCan(actor, 'withdrawals.view', 'view the withdrawal volume trend');
    const window = parseDays(days);

    return {
      days: window,
      points: await this.stats.withdrawalVolumeByDay(actor.clientScope, window),
      scoped: !actor.clientScope.unrestricted,
    };
  }
}

/** The widest window a chart may ask for. A year of daily points is 365 rows. */
export const MAX_TREND_DAYS = 365;
export const MIN_TREND_DAYS = 1;
export const DEFAULT_TREND_DAYS = 30;

/**
 * `?days=` → a bounded integer, or a 400 naming the range — R-2.5.
 *
 * ## Never a silent clamp, and never a silent fallback
 *
 * The tempting shapes are `Math.min(365, Number(days) || 30)` and
 * `Number.parseInt(days) || 30`. Both are lies the UI then tells: an operator
 * asks for 3650 days and gets 365 with nothing to say the answer is not the
 * question, or types `3O` and gets a default month back that looks like real
 * data for a period they did not choose. The sorting allowlist in
 * `common/sorting.ts` refuses for the same reason and in the same words — a
 * silently ignored parameter is indistinguishable from a broken screen.
 *
 * An ABSENT value is a different thing and takes the default: not asking for a
 * window is not the same as asking for a bad one.
 *
 * `Number.parseInt` with an explicit radix, and then a re-serialisation check.
 * `parseInt('30abc')` is 30 and `parseInt('3.9')` is 3 — both accept input the
 * caller did not mean, and the second silently changes the window. Comparing
 * `String(parsed)` back to the trimmed input is what makes "30abc" a 400 rather
 * than a month.
 *
 * This is not a money path — `days` is a count of calendar days — so
 * `Number.parseInt` is the right tool here, unlike on any amount.
 */
export function parseDays(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === '') return DEFAULT_TREND_DAYS;

  const trimmed = raw.trim();
  const parsed = Number.parseInt(trimmed, 10);

  if (!Number.isFinite(parsed) || String(parsed) !== trimmed) {
    throw new ValidationError(
      `"days" must be a whole number between ${MIN_TREND_DAYS} and ${MAX_TREND_DAYS}. Received "${raw}".`,
    );
  }
  if (parsed < MIN_TREND_DAYS || parsed > MAX_TREND_DAYS) {
    throw new ValidationError(
      `"days" must be between ${MIN_TREND_DAYS} and ${MAX_TREND_DAYS}. Received ${parsed}.`,
    );
  }
  return parsed;
}
