import { Injectable } from '@nestjs/common';
import {
  PaymentIndeterminateError,
  ValidationError,
} from '../../../../common/errors/domain-errors';
import { RIVAL_MONEY_SCALE, RivalClient } from './rival.client';
import { RivalConfigService } from './rival-config.service';
import { RivalPayouts } from './rival-payouts';
import { wishDestinationIssue } from './wish-phone';
import type {
  ConnectionCheck,
  PaymentChannel,
  PaymentProviderAdapter,
  PaymentStatus,
  ProviderConfigField,
  StartedPayment,
  StartPaymentInput,
} from '../payment-provider';

export { RIVAL_PAYOUT_METHODS } from './rival-payouts';

/**
 * RIVAL — the company's payment platform, as a provider (0168; a thin adapter
 * since 0173).
 *
 * Whish is a rail INSIDE Rival, so it is one of Rival's channels, not a
 * provider of its own: deposits through Rival's hosted Whish page, payouts
 * through Rival's `WISH` payout. Rival's docs also accept `CASH` and `CRYPTO`
 * payouts — each becomes one more channel here the day it is wanted.
 *
 * This folder only TRANSLATES: Rival's HTTP (`rival.client.ts`), its settings
 * (`rival-config.service.ts`), its signature (`rival-signature.ts`), its
 * webhook (`rival-webhook.receiver.ts`), its payouts (`rival-payouts.ts`). The
 * money — settling, refunding, adopting, asking people — is the core's.
 */
@Injectable()
export class RivalPaymentProvider implements PaymentProviderAdapter {
  readonly code = 'rival';
  readonly name = 'Rival';
  readonly builtIn = false;
  readonly webhookPath = '/v1/payments/rival/webhook';

  readonly configFields: readonly ProviderConfigField[] = [
    {
      name: 'baseUrl',
      label: 'API base URL',
      kind: 'url',
      required: true,
      hint: 'Rival’s company API, e.g. https://portal.rivalpayments.com/v1',
    },
    {
      name: 'apiKey',
      label: 'Company API key',
      kind: 'secret',
      required: true,
      hint: 'The tsk_… key from Rival’s dashboard. Write-only.',
    },
    {
      name: 'webhookKey',
      label: 'Webhook key',
      kind: 'secret',
      required: false,
      generated: true,
      hint: 'Minted here and pasted into Rival’s dashboard; Rival signs every event with it.',
    },
  ];

  readonly channels: readonly PaymentChannel[] = [
    {
      code: 'whish',
      direction: 'deposit',
      label: 'Whish',
      flow: 'redirect',
      settlementScale: RIVAL_MONEY_SCALE,
      // Rival judges which currencies its Whish rail carries for this company.
      currencies: 'any',
      bindable: true,
      // A Whish link is fixed-amount: any other figure is a person's.
      creditPolicy: 'exact',
      hostedPageReturns: true,
    },
    {
      code: 'whish',
      direction: 'payout',
      label: 'Whish',
      flow: 'automated',
      settlementScale: RIVAL_MONEY_SCALE,
      currencies: 'any',
      bindable: true,
      destination: {
        kind: 'phone',
        label: 'Whish phone number',
        // Rival's own WISH rule, ported (`wish-phone.ts`).
        validate: (value) => wishDestinationIssue(value) ?? undefined,
      },
    },
  ];

  readonly payouts: RivalPayouts;

  constructor(
    private readonly rival: RivalClient,
    private readonly config: RivalConfigService,
  ) {
    this.payouts = new RivalPayouts(rival);
  }

  /** Switched on, configured, and not sandbox on production (`RivalConfigService`). */
  isUsable(): Promise<boolean> {
    return this.config.isEnabled();
  }

  settingsChanged(): void {
    this.config.invalidate();
  }

  async testConnection(): Promise<ConnectionCheck> {
    try {
      const crm = await this.rival.getCrmConfig();
      return {
        ok: true,
        message: crm.enabled
          ? 'Connected. Rival accepts the API key and will deliver events.'
          : 'Connected, but event delivery is switched off in Rival’s dashboard.',
      };
    } catch (error) {
      return { ok: false, message: error instanceof Error ? error.message : String(error) };
    }
  }

  async startPayment(channel: PaymentChannel, input: StartPaymentInput): Promise<StartedPayment> {
    this.assertWhishDeposit(channel);
    const payment = await this.rival.createWhishPayment(input);
    if (!payment.collectUrl) {
      /*
       * Rival recorded the payment but produced no page. The deposit exists on
       * both sides, so it must not be created again — the sweep finishes it.
       */
      throw new PaymentIndeterminateError(
        'The payment platform recorded the deposit but could not produce a payment page. ' +
          'It will be retried automatically — do not create a second deposit.',
        { providerPaymentId: payment.externalId },
      );
    }
    return { paymentUrl: payment.collectUrl, externalId: payment.externalId };
  }

  async checkPayment(channel: PaymentChannel, externalId: string): Promise<PaymentStatus> {
    this.assertWhishDeposit(channel);
    const payment = await this.rival.getWhishPayment(externalId);
    return {
      settled: payment.status === 'PAID' || payment.status === 'FAILED',
      paid: payment.status === 'PAID',
      rawStatus: payment.status,
      needsAttention: payment.needsAttention,
      amount: payment.amount,
      currency: payment.currency,
    };
  }

  /**
   * A start whose answer was lost: Rival's documented replay semantics make a
   * create under the SAME idempotency key converge — an existing payment is
   * returned unchanged, a linkless one re-minted, and only when nothing exists
   * is one made. Never "absent": the replay always answers with the payment.
   */
  async recoverPayment(
    channel: PaymentChannel,
    input: StartPaymentInput,
  ): Promise<StartedPayment | null> {
    this.assertWhishDeposit(channel);
    try {
      const payment = await this.rival.createWhishPayment(input);
      return { paymentUrl: payment.collectUrl ?? '', externalId: payment.externalId };
    } catch (error) {
      const externalId =
        error instanceof PaymentIndeterminateError ? error.details?.['providerPaymentId'] : null;
      if (typeof externalId === 'string' && externalId.length > 0) {
        return { paymentUrl: '', externalId };
      }
      throw error;
    }
  }

  /** Rival re-asks Whish — its documented recovery for a callback Rival itself missed. */
  async refreshPayment(channel: PaymentChannel, externalId: string): Promise<void> {
    this.assertWhishDeposit(channel);
    await this.rival.refreshWhishPayment(externalId);
  }

  private assertWhishDeposit(channel: PaymentChannel): void {
    if (channel.code !== 'whish' || channel.direction !== 'deposit') {
      throw new ValidationError(`Rival has no hosted payment for ${channel.code}.`);
    }
  }
}
