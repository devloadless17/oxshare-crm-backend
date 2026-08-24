import { Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ValidationError } from '../../../common/errors/domain-errors';
import { AppSettingsStore } from '../../../store/app-settings.store';
import { LeveragesService } from '../../leverages/leverages.service';
import { ProductsStore, type OfferedGroup } from '../../../store/products.store';
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
    private readonly products: ProductsStore,
    /*
     * The ladder, since migration 0067 moved it out of the settings row.
     * APPENDED LAST because this class is constructed positionally in
     * `self-service-groups.spec.ts`.
     */
    private readonly leverageLadder: LeveragesService,
  ) {}

  /**
   * Say at boot which doors are open.
   *
   * Hiding the portal button for an unconfigured environment is right for a
   * CLIENT and terrible for whoever is setting the system up: "not configured"
   * and "not built" look identical from the browser, and there is nothing to
   * grep for. One line at startup is the thing anyone would look at first.
   */
  async onModuleInit(): Promise<void> {
    await this.importLegacyEnvGroups();

    const products = await this.products.listProducts();
    const configured = products.filter((product) => product.groups.length > 0);

    if (configured.length === 0) {
      this.logger.warn(
        'Self-service account opening is OFF: no product has an MT5 group attached. The portal ' +
          'will show no "Open account" button. Add one at Settings, choosing from the groups the ' +
          'bridge reports.',
      );
      return;
    }

    for (const product of configured) {
      const live = product.groups.filter((group) => group.environment === 'live').length;
      const demo = product.groups.filter((group) => group.environment === 'demo').length;
      this.logger.log(
        `Product "${product.name}"${product.enabled ? '' : ' (disabled)'}: ` +
          `${live} live group(s), ${demo} demo group(s)`,
      );
    }
  }

  /**
   * Carry `MT5_CLIENT_GROUPS_*` into the product catalogue, once.
   *
   * ## Why this runs in the app and not in the migration
   *
   * A migration cannot read a `.env` file, and the groups a deployment offers
   * live in one. So 0052 creates an empty "Standard" product and this fills it
   * on the first boot after the upgrade — the import stays beside the code that
   * knows how to parse the variable.
   *
   * It is a no-op the moment ANY product has a group, so it cannot re-add one
   * an operator deliberately removed. That is also why it does not run
   * per-product: "this product has no groups yet" is a normal state an operator
   * passes through on the way to configuring one.
   *
   * The currency is left EMPTY. It is read live from MT5 wherever a client sees
   * it, and writing a guessed 'USD' here would put an unverified currency on a
   * settings screen where it reads as fact.
   */
  private async importLegacyEnvGroups(): Promise<void> {
    const legacy = (['live', 'demo'] as const).flatMap((environment) =>
      this.legacyEnvGroups(environment).map((mt5Group) => ({ environment, mt5Group })),
    );
    if (legacy.length === 0) return;

    const products = await this.products.listProducts();
    if (products.length === 0) return;
    if (products.some((product) => product.groups.length > 0)) return;

    /*
     * Since products carry a TYPE, each environment goes to the product that
     * may hold it: live groups to the first real product, demo groups to THE
     * demo product (migration 0088 guarantees one exists). A missing target is
     * logged rather than worked around — attaching a demo group to a real
     * product would be refused by the service and ignored by the resolution.
     */
    const targetFor = {
      live: products.find((product) => product.type === 'real'),
      demo: products.find((product) => product.type === 'demo'),
    };

    for (const { environment, mt5Group } of legacy) {
      const target = targetFor[environment];
      if (!target) {
        this.logger.warn(
          `Cannot import ${environment} group "${mt5Group}" from the environment: no ` +
            `${environment === 'demo' ? 'demo' : 'real'} product exists to hold it.`,
        );
        continue;
      }
      try {
        await this.products.addGroup({ productId: target.id, environment, mt5Group, currency: '' });
        this.logger.log(
          `Imported ${environment} group "${mt5Group}" from the environment into product ` +
            `"${target.name}". Set its currency on the products screen.`,
        );
      } catch {
        // Another instance won the race, or the group is already claimed by a
        // product. Both mean the catalogue already says what this was saying.
      }
    }
  }

  /** The retired environment variables, still read for the one-time import. */
  private legacyEnvGroups(environment: 'live' | 'demo'): string[] {
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

  /**
   * What THIS client may open in an environment.
   *
   * Per-client, which an environment variable could never be: a client under an
   * introducing broker is offered their partner's agency's products, and a
   * client under nobody is offered every enabled product.
   */
  async offeredTo(userId: string, environment: 'live' | 'demo'): Promise<OfferedGroup[]> {
    return await this.products.offeredTo(userId, environment);
  }

  /**
   * Validate a client's chosen group, or pick the first they are offered.
   *
   * ## The check is the whole point of this method
   *
   * `group` arrives from a browser. Without validating it against what this
   * client is offered, they could name ANY group the catalogue knows —
   * including one belonging to another partner's agency, whose commission would
   * then be paid to somebody who introduced nobody. The portal's dropdown is a
   * convenience; this is the control.
   */
  async resolve(userId: string, environment: 'live' | 'demo', requested?: string): Promise<string> {
    const offered = await this.offeredTo(userId, environment);

    if (offered.length === 0) {
      throw new ValidationError(
        environment === 'live'
          ? 'Opening a live account online is not available yet. Please contact support.'
          : 'Demo accounts are not available online yet. Please contact support.',
      );
    }

    if (!requested) return offered[0].mt5Group;

    /*
     * Case-insensitive, because MT5 group paths are and a browser round trip
     * can change nothing else about the string. Matched against the OFFERED
     * spelling, which is what gets sent onward — never the caller's, so a
     * casing difference cannot reach the server.
     */
    const match = offered.find(
      (option) => option.mt5Group.toLowerCase() === requested.trim().toLowerCase(),
    );
    if (!match) {
      throw new ValidationError('That account type is not available. Choose one from the list.');
    }

    return match.mt5Group;
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
   * that changes without a deploy. It was `MT5_CLIENT_LEVERAGES`, then a CSV on
   * the trading settings row, and it is the `leverages` TABLE now (migration
   * 0067) — one row per rung, so one can be withdrawn without touching the
   * accounts already opened on it.
   *
   * ENABLED rungs only, in the operator's order. `LeveragesService` filters
   * rather than flagging, so this cannot forget to.
   */
  async leverages(): Promise<number[]> {
    return this.leverageLadder.listEnabled();
  }

  /**
   * Every operator-set number in one read: the ladder and the caps.
   *
   * The offer endpoint needs all of them at once, and asking for them
   * separately would be three reads of the same single-row table for one
   * response.
   */
  async terms(): Promise<TradingTerms> {
    return tradingTermsFrom(await this.settings.getTrading());
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
