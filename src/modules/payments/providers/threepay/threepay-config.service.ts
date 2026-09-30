import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Decimal from 'decimal.js';
import { openSecret } from '../../../../common/security/secret-box';
import { PaymentProvidersStore } from '../../../../store/payment-providers.store';

/** The provider code — a code may not start with a digit, so not `3pay`. */
export const THREEPAY_CODE = 'threepay';

/** The two assets 3pay moves (its `currencyType`), one per network. */
export type ThreePayAsset = 'USDT-TRC20' | 'USDT-ERC20';

/** The settings this adapter declares (`ThreePayPaymentProvider.configFields`). */
export const THREEPAY_SETTINGS = {
  baseUrl: 'baseUrl',
  apiKey: 'apiKey',
  apiSecret: 'apiSecret',
  trc20PayoutFee: 'trc20PayoutFee',
  erc20PayoutFee: 'erc20PayoutFee',
} as const;

export interface ThreePayConfig {
  baseUrl: string;
  /** 3pay's `apikey` — a public identifier (its guide: "safe to log"). */
  apiKey: string;
  /** 3pay's `x-api-secret`. Also the key 3pay signs its webhooks with. */
  apiSecret: string;
  /** 3pay's withdrawal fee per network, in USDT — what a payout is grossed up by. */
  payoutFees: Readonly<Record<ThreePayAsset, string>>;
  enabled: boolean;
}

const CACHE_TTL_MS = 10_000;

/**
 * The problem with a payout fee as typed, or undefined — a decimal of at most
 * 2 places, zero or more (3pay settles in cents). Checked when the settings
 * are SAVED, and again here, so a bad value is never a payout's surprise.
 */
export function payoutFeeIssue(value: string): string | undefined {
  const text = value.trim();
  if (!/^\d{1,6}(\.\d{1,2})?$/.test(text)) {
    return 'A fee in USDT with at most 2 decimal places, e.g. 2.00.';
  }
  return undefined;
}

/**
 * THE 3PAY CONNECTION IN FORCE (0174) — from the generic `payment_providers`
 * row the console edits, and nowhere else: 3pay has no environment floor, so a
 * deployment with no row configured simply has no 3pay.
 *
 * The one class that OPENS 3pay's secret, on its way to an outbound call or to
 * verifying an inbound signature. Resolves to null — "not configured" — when
 * any required setting is missing, the secret will not decrypt, a fee is not a
 * decimal, or the row is marked sandbox on a production deployment (3pay has no
 * sandbox; a row saying so is a mistake, and a mistake must not move real
 * money). Ten seconds of cache, dropped on every save (`invalidate`).
 */
@Injectable()
export class ThreePayConfigService {
  private readonly logger = new Logger(ThreePayConfigService.name);
  private cached: { value: ThreePayConfig | null; at: number } | null = null;

  constructor(
    private readonly providers: PaymentProvidersStore,
    private readonly config: ConfigService,
  ) {}

  async resolve(): Promise<ThreePayConfig | null> {
    if (this.cached && Date.now() - this.cached.at < CACHE_TTL_MS) return this.cached.value;
    const value = await this.load();
    this.cached = { value, at: Date.now() };
    return value;
  }

  /** Configured AND switched on. */
  async isUsable(): Promise<boolean> {
    return (await this.resolve())?.enabled ?? false;
  }

  invalidate(): void {
    this.cached = null;
  }

  private async load(): Promise<ThreePayConfig | null> {
    const row = await this.providers.get(THREEPAY_CODE);
    if (!row) return null;
    if (row.environment === 'sandbox' && this.config.get<string>('NODE_ENV') === 'production') {
      this.logger.error(
        '3pay is marked SANDBOX on a production deployment; refusing it. 3pay has no sandbox: ' +
          'set it to live in Payment providers.',
      );
      return null;
    }
    const baseUrl = row.config[THREEPAY_SETTINGS.baseUrl]?.trim();
    const apiKey = row.config[THREEPAY_SETTINGS.apiKey]?.trim();
    const sealed = row.secrets[THREEPAY_SETTINGS.apiSecret];
    const trc20 = row.config[THREEPAY_SETTINGS.trc20PayoutFee]?.trim();
    const erc20 = row.config[THREEPAY_SETTINGS.erc20PayoutFee]?.trim();
    if (!baseUrl || !apiKey || !sealed || !trc20 || !erc20) return null;
    if (payoutFeeIssue(trc20) || payoutFeeIssue(erc20)) {
      this.logger.error(
        'A stored 3pay payout fee is not a decimal; treating 3pay as unconfigured.',
      );
      return null;
    }

    let apiSecret: string;
    try {
      apiSecret = openSecret(sealed, this.config.get<string>('APP_ENCRYPTION_KEY'));
    } catch (error) {
      this.logger.error(
        'The stored 3pay API secret could not be decrypted; treating 3pay as unconfigured. ' +
          `Save the secret again in Payment providers. ${
            error instanceof Error ? error.message : String(error)
          }`,
      );
      return null;
    }

    return {
      baseUrl: baseUrl.replace(/\/+$/, ''),
      apiKey,
      apiSecret,
      payoutFees: {
        'USDT-TRC20': new Decimal(trc20).toFixed(2),
        'USDT-ERC20': new Decimal(erc20).toFixed(2),
      },
      enabled: row.enabled,
    };
  }
}
