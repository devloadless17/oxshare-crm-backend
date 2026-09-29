import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { openSecret } from '../../../common/security/secret-box';
import { AppSettingsStore } from '../../../store/app-settings.store';

/**
 * Resolves the Rival connection actually in force: the admin-managed row if
 * there is one, the environment otherwise.
 *
 * ── The only opener ────────────────────────────────────────────────────────
 *
 * This is the ONE class that turns `rival_settings`' two ciphertexts back into
 * usable secrets — the API key on the way to an outbound call, the webhook key
 * on the way to verifying an inbound signature. `RivalSettingsService` seals
 * and never opens; keeping the directions in separate classes means "who can
 * read the Rival credentials" is answerable by finding the injections of this
 * class, exactly as `SmtpConfigService` does for the mail password.
 *
 * ── Env is the floor, not the default ──────────────────────────────────────
 *
 * The row wins WHOLE, never field by field. A half-merged configuration — the
 * row's base URL with the environment's key — would authenticate against a
 * server nobody chose with a credential minted for another one, and the
 * settings screen would show a configuration that is not the one in force.
 * Same rule, same reasoning as `SmtpConfigService`.
 *
 * Unlike SMTP there is no boot-time requirement: a deployment with no Rival
 * config simply has the whish deposit method unavailable, which
 * `PaymentMethodsService` already renders honestly as "not offered".
 *
 * ── The cache, and why it is short ─────────────────────────────────────────
 *
 * The webhook verifier runs this on every delivery and AES decryption per
 * request is waste. Ten seconds is long enough to amortise a burst of
 * webhooks and short enough that a key rotation is live before Rival's first
 * retry (60s) comes back. `invalidate()` is called on every settings write, so
 * within one instance the cache never serves a stale credential at all; the
 * TTL is the cross-instance bound.
 */

export interface EffectiveRivalConfig {
  baseUrl: string;
  apiKey: string;
  /** Null until the operator mints one — inbound webhooks refuse until then. */
  webhookKey: string | null;
  enabled: boolean;
  /** Where this came from, for the settings screen and log lines. */
  source: 'database' | 'environment';
  /** `live` or `sandbox` (0168). A production deployment never resolves `sandbox`. */
  environment: 'live' | 'sandbox';
}

const CACHE_TTL_MS = 10_000;

@Injectable()
export class RivalConfigService {
  private readonly logger = new Logger(RivalConfigService.name);

  private cached: { value: EffectiveRivalConfig | null; at: number } | null = null;

  constructor(
    private readonly settings: AppSettingsStore,
    private readonly config: ConfigService,
  ) {}

  /**
   * The configuration in force, or null when Rival is not configured at all.
   *
   * "Configured" means a base URL AND an API key from the same source. A row
   * holding only one of them resolves to null rather than borrowing the
   * other from the environment — see the class comment.
   */
  async resolve(): Promise<EffectiveRivalConfig | null> {
    if (this.cached && Date.now() - this.cached.at < CACHE_TTL_MS) {
      return this.cached.value;
    }
    const value = await this.load();
    this.cached = { value, at: Date.now() };
    return value;
  }

  /** Configured AND switched on — the gate `PaymentGatewaysService` asks. */
  async isEnabled(): Promise<boolean> {
    const config = await this.resolve();
    return config !== null && config.enabled;
  }

  /** Called by every settings write so a save is live on the next request. */
  invalidate(): void {
    this.cached = null;
  }

  private async load(): Promise<EffectiveRivalConfig | null> {
    const row = await this.settings.getRival();

    /*
     * A row that EXISTS but is incomplete — a base URL without a key, or the
     * reverse — resolves to null, NOT to the environment. The operator has
     * moved configuration into the database; falling back would call the
     * environment's host with the environment's key while the settings screen
     * shows the row's values, which is the half-merged state the class
     * comment forbids. The env floor applies only while no row exists at all.
     */
    if (row && !(row.baseUrl && row.apiKeyCiphertext)) {
      return null;
    }

    if (row && row.baseUrl && row.apiKeyCiphertext) {
      /*
       * A SANDBOX configuration on a PRODUCTION deployment is refused outright
       * (0168): a sandbox webhook must never be able to credit real money, and
       * a sandbox URL pasted into production is the mistake that would allow
       * it. Rival then reads as unconfigured — nothing is offered or paid — and
       * the log says why.
       */
      const environment = row.environment === 'sandbox' ? 'sandbox' : 'live';
      if (environment === 'sandbox' && this.config.get<string>('NODE_ENV') === 'production') {
        this.logger.error(
          'Rival is configured as SANDBOX on a production deployment; refusing it. ' +
            'Set it to live, or use it on a sandbox deployment, in Payment providers.',
        );
        return null;
      }
      const key = this.config.get<string>('APP_ENCRYPTION_KEY');
      let apiKey: string;
      try {
        apiKey = openSecret(row.apiKeyCiphertext, key);
      } catch (error) {
        /*
         * A key that will not decrypt is NOT a reason to fall back to the
         * environment: the operator configured this connection deliberately,
         * and silently moving the money pipe to a different Rival host because
         * an encryption-key rotation went wrong is the silent substitution
         * this codebase refuses everywhere. Resolve to "not configured" — the
         * deposit method goes honestly unavailable and the log says why.
         */
        this.logger.error(
          'Stored Rival API key could not be decrypted; treating Rival as unconfigured. ' +
            'Re-save the API key in Settings → Payments. ' +
            (error instanceof Error ? error.message : String(error)),
        );
        return null;
      }

      let webhookKey: string | null = null;
      if (row.webhookKeyCiphertext) {
        try {
          webhookKey = openSecret(row.webhookKeyCiphertext, key);
        } catch (error) {
          // Outbound still works; inbound verification refuses until re-minted.
          this.logger.error(
            'Stored Rival webhook key could not be decrypted; inbound webhooks will be ' +
              'refused until a new key is generated in Settings → Payments. ' +
              (error instanceof Error ? error.message : String(error)),
          );
        }
      }

      return {
        baseUrl: stripTrailingSlash(row.baseUrl),
        apiKey,
        webhookKey,
        enabled: row.enabled,
        source: 'database',
        environment,
      };
    }

    // The development floor. Not accepted in production-shape deployments as
    // the primary config, but there is no boot-time chicken-and-egg here so it
    // is optional everywhere — see env.validation.ts.
    const baseUrl = this.config.get<string>('RIVAL_BASE_URL');
    const apiKey = this.config.get<string>('RIVAL_API_KEY');
    if (baseUrl && apiKey) {
      return {
        baseUrl: stripTrailingSlash(baseUrl),
        apiKey,
        webhookKey: this.config.get<string>('RIVAL_WEBHOOK_KEY') ?? null,
        // Env config carries no switch; being set is being on.
        enabled: true,
        source: 'environment',
        environment: 'live',
      };
    }

    return null;
  }
}

/** `https://host/v1/` and `https://host/v1` must build identical URLs. */
function stripTrailingSlash(url: string): string {
  return url.endsWith('/') ? url.slice(0, -1) : url;
}
