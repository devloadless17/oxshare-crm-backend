import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Decimal from 'decimal.js';

/**
 * Absolute bounds on money, independent of any business configuration.
 *
 * PLATFORM-CONVENTIONS R-5.1 and §12.4. These are not commercial rules — those
 * live in `ib_programs` where the client edits them (D-39). These are the
 * ceilings that must hold even when the commercial rules are WRONG.
 *
 * The concrete reason they exist:
 *
 *   DECISIONS D-11 is still OPEN — nobody has confirmed whether MT5's `spread`
 *   field is points, pips, or account currency. D-40 records a second unverified
 *   assumption, that `spread_share` multiplies by volume. If either is wrong by
 *   a factor of 100, the engine produces commission wrong by a factor of 100 —
 *   and until now there was no ceiling anywhere to stop that being accrued,
 *   confirmed, and paid out. Phase 1 has no clawback.
 *
 * A breach REFUSES and alerts. It never clamps: a clamped value is a wrong value
 * that looks deliberate, and it would be indistinguishable in the ledger from a
 * correct one. Refusing leaves the deal un-accrued and loud, which is a problem
 * someone fixes rather than a number someone trusts.
 *
 * Every value is an ASSUMPTION until the client confirms it (working agreement:
 * "never hardcode a number nobody gave us"). They live in config so confirming
 * one is an env change, never a code change.
 */
@Injectable()
export class MoneyLimits {
  constructor(private readonly config: ConfigService) {}

  private decimal(key: string, fallback: string): Decimal {
    const raw = this.config.get<string>(key);
    // A malformed limit must not silently become "no limit". Falling back to the
    // documented default is the safe reading; the value is also validated at
    // boot in env.validation.ts.
    try {
      const value = new Decimal(raw ?? fallback);
      return value.isFinite() && value.isPositive() ? value : new Decimal(fallback);
    } catch {
      return new Decimal(fallback);
    }
  }

  /** Below this a withdrawal costs more in provider fees than it moves. */
  minWithdrawal(): Decimal {
    return this.decimal('WITHDRAWAL_MIN', '10');
  }

  /** ASSUMPTION — pending client confirmation. Per single withdrawal. */
  maxWithdrawal(): Decimal {
    return this.decimal('WITHDRAWAL_MAX', '50000');
  }

  /** ASSUMPTION — pending client confirmation. Per user, rolling 24 hours. */
  maxWithdrawalPerDay(): Decimal {
    return this.decimal('WITHDRAWAL_DAILY_MAX', '100000');
  }

  /**
   * Below this a manual deposit costs more in operator time than it moves.
   *
   * A declared deposit is not money yet — nothing is credited until somebody
   * confirms the transfer arrived — so this bound is not protecting a balance.
   * It is protecting the reconciliation queue: a stream of one-dollar
   * declarations is a denial of service against the person working through it.
   */
  minDeposit(): Decimal {
    return this.decimal('DEPOSIT_MIN', '10');
  }

  /**
   * ASSUMPTION — pending client confirmation. Per single declared deposit.
   *
   * Deliberately generous compared to the withdrawal ceiling: a large INBOUND
   * declaration is a compliance question for the operator to answer with the
   * money in view, not something to refuse at the door. It exists so a typo
   * ("500000" for "5000") is caught while the client is still looking at the
   * form rather than after a wire arrives.
   */
  maxDeposit(): Decimal {
    return this.decimal('DEPOSIT_MAX', '250000');
  }

  /*
   * ── The two below have NO CALLER today ──────────────────────────────────
   *
   * They are the D-11 commission backstops, and the engine they guard went with
   * the money teardown. Kept rather than deleted because `env.validation.ts`
   * still validates both variables at boot, the reasoning below is the
   * expensive part to reconstruct, and the engine returns with the MT5 bridge.
   *
   * A reader should not mistake their presence for a live control: nothing
   * calls these until a deal exists to calculate a commission on.
   */

  /**
   * The most any single closed deal may ever produce for one IB leg.
   *
   * This is the D-11 backstop. A plausible spread-based commission on a retail
   * deal is cents to a few dollars; anything approaching this number means the
   * unit assumption is wrong, not that someone had a very good trade.
   */
  maxCommissionPerDeal(): Decimal {
    return this.decimal('COMMISSION_MAX_PER_DEAL', '1000');
  }

  /**
   * A relative ceiling, because an absolute one alone scales badly: it catches a
   * unit error on a small deal but not on a large one, where 100× wrong can
   * still look unremarkable next to a fixed cap.
   *
   * Expressed as a multiple of the deal's SPREAD REVENUE (`spread × volume`),
   * and applied only to the `spread_share` method — the only one where the
   * commission is derived from the spread at all. `per_lot` multiplies by volume
   * and `fixed_per_deal` is a flat amount; for those, "a share of the deal" has
   * no meaning, and a small-spread deal would breach any such ratio while being
   * perfectly correct. The absolute ceiling covers them.
   *
   * The default is 1, not a fraction, and that is deliberate. `ProgramsService`
   * permits `commissionValue` up to 100% for spread_share and `l1Share + l2Share`
   * up to 100%, so the largest LEGITIMATE leg is exactly the whole spread
   * revenue. Anything above that is not an aggressive commercial deal, it is
   * arithmetically impossible — which is precisely the D-11 signature, where a
   * points-vs-currency mix-up inflates the result by orders of magnitude.
   *
   * A tighter default would refuse configurations the validator explicitly
   * allows, and a backstop that fires on correct data is one somebody switches
   * off.
   */
  maxCommissionShareOfDeal(): Decimal {
    return this.decimal('COMMISSION_MAX_SHARE_OF_DEAL', '1');
  }
}
