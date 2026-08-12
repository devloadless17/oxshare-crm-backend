import { Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ValidationError } from '../../../common/errors/domain-errors';
import { AppSettingsStore } from '../../../store/app-settings.store';
import { tradingTermsFrom, type TradingTerms } from '../../../common/trading-terms';

/**
 * Which MT5 groups a CLIENT may open an account in, and on what terms.
 *
 * ## Clients choose a PRODUCT, not a group
 *
 * An earlier version of this offered no choice at all: one configured group per
 * environment, on the reasoning that picking a group means picking your own
 * commission plan and leverage tier. That reasoning is right about what a group
 * IS and wrong about what a client needs — every broker portal lets somebody
 * choose Standard or ECN, a currency, and a leverage, because those are the
 * terms of the account they are opening and they are entitled to decide them.
 *
 * The resolution is a CURATED list. The broker names the groups it is willing
 * to sell online; this reads their real currency back from MT5 so the portal
 * shows what an account will actually be denominated in, and validates every
 * incoming choice against the same list. A client still cannot reach a group
 * the broker did not offer — which is the part the original design was
 * protecting.
 *
 * ## Unset means the door is CLOSED
 *
 * A missing list is not a broken deployment to route around; it is a broker who
 * has not opted into self-service for that environment. The portal hides the
 * button rather than offering something the API will refuse.
 */
@Injectable()
export class SelfServiceGroups implements OnModuleInit {
  private readonly logger = new Logger(SelfServiceGroups.name);

  constructor(
    private readonly config: ConfigService,
    private readonly settings: AppSettingsStore,
  ) {}

  /**
   * Say at boot which doors are open.
   *
   * Hiding the portal button for an unconfigured environment is right for a
   * CLIENT and terrible for whoever is setting the system up: "not configured"
   * and "not built" look identical from the browser, and there is nothing to
   * grep for. One line at startup is the thing anyone would look at first.
   */
  onModuleInit(): void {
    const live = this.groupsFor('live');
    const demo = this.groupsFor('demo');

    if (live.length === 0 && demo.length === 0) {
      this.logger.warn(
        'Self-service account opening is OFF for both environments: neither ' +
          'MT5_CLIENT_GROUPS_LIVE nor MT5_CLIENT_GROUPS_DEMO is set. The portal will show no ' +
          '"Open account" button. Set them to the groups the broker sells online, ' +
          'comma-separated.',
      );
      return;
    }

    this.logger.log(
      `Self-service account opening: live=[${live.join(', ') || 'OFF'}], ` +
        `demo=[${demo.join(', ') || 'OFF'}]`,
    );
  }

  /**
   * The groups offered for an environment, in the order the broker listed them.
   *
   * Reads the plural variable, falling back to the singular one this replaced.
   * A deployment configured before the list existed keeps working rather than
   * silently losing its self-service.
   */
  groupsFor(environment: 'live' | 'demo'): string[] {
    const suffix = environment === 'live' ? 'LIVE' : 'DEMO';
    const raw =
      this.config.get<string>(`MT5_CLIENT_GROUPS_${suffix}`) ??
      this.config.get<string>(`MT5_CLIENT_GROUP_${suffix}`) ??
      '';

    return raw
      .split(',')
      .map((group) => group.trim())
      .filter(Boolean);
  }

  /** Whether self-service is switched on for an environment — for the UI. */
  isEnabled(environment: 'live' | 'demo'): boolean {
    return this.groupsFor(environment).length > 0;
  }

  /**
   * Validate a client's chosen group, or pick the first offered one.
   *
   * ## The check is the whole point of this method
   *
   * `group` arrives from a browser. Without validating it against the offered
   * list, a client could name ANY group on the broker's server — including an
   * institutional one with terms nobody agreed to sell them. The portal's
   * dropdown is a convenience; this is the control.
   */
  resolve(environment: 'live' | 'demo', requested?: string): string {
    const offered = this.groupsFor(environment);

    if (offered.length === 0) {
      throw new ValidationError(
        environment === 'live'
          ? 'Opening a live account online is not available yet. Please contact support.'
          : 'Demo accounts are not available online yet. Please contact support.',
      );
    }

    if (!requested) return offered[0];

    /*
     * Case-insensitive, because MT5 group paths are and a browser round trip
     * can change nothing else about the string. Matched against the OFFERED
     * spelling, which is what gets sent onward — never the caller's, so a
     * casing difference cannot reach the server.
     */
    const match = offered.find((group) => group.toLowerCase() === requested.trim().toLowerCase());
    if (!match) {
      throw new ValidationError('That account type is not available. Choose one from the list.');
    }

    return match;
  }

  /**
   * The leverages a client may choose.
   *
   * A fixed ladder rather than a free number: leverage is a risk control, and a
   * text box invites 1:5000 on an account the group would clamp anyway — which
   * shows the client one figure and gives them another.
   *
   * MT5 clamps to the group's own maximum regardless, so this list is the
   * offer and the server is the authority.
   *
   * ## Why it comes from the DATABASE and not the environment
   *
   * Which leverages a broker advertises is a regulatory and commercial call
   * that changes without a deploy. It used to be `MT5_CLIENT_LEVERAGES`, which
   * is still read as the SEED for a deployment that has never opened the
   * Trading settings tab — after the first save, the table is the only answer.
   */
  async leverages(): Promise<number[]> {
    return (await this.terms()).leverages;
  }

  /**
   * Every operator-set number in one read: the ladder and the caps.
   *
   * The offer endpoint needs all of them at once, and asking for them
   * separately would be three reads of the same single-row table for one
   * response.
   */
  async terms(): Promise<TradingTerms> {
    return tradingTermsFrom(
      await this.settings.getTrading(),
      this.config.get<string>('MT5_CLIENT_LEVERAGES'),
    );
  }

  /** Validate a chosen leverage, or fall back to the middle of the ladder. */
  async resolveLeverage(requested?: number): Promise<number> {
    const allowed = await this.leverages();
    if (requested && allowed.includes(requested)) return requested;
    if (requested) {
      throw new ValidationError('That leverage is not available. Choose one from the list.');
    }
    // The median rather than the maximum: an unspecified leverage should not
    // hand somebody the riskiest option the broker allows.
    return allowed[Math.floor(allowed.length / 2)] ?? 100;
  }
}
