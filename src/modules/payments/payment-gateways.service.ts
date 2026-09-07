import { Injectable } from '@nestjs/common';
import { PaymentIndeterminateError, ValidationError } from '../../common/errors/domain-errors';
import { RivalClient } from './rival/rival.client';
import { RivalConfigService } from './rival/rival-config.service';

/**
 * The registry that maps a payment method KEY to the provider behind it.
 *
 * ## This is now the ONLY answer to "how does a deposit through X work?"
 *
 * There used to be a second one: a `kind` column on the method, which an
 * operator picked from a dropdown. It was dropped in migration 0043 because it
 * was never a fact about the row — it was a fact about whether the code in this
 * file has a case for that key, which is what every reader had already started
 * asking instead.
 *
 * ## `whish` now means "through Rival"
 *
 * The key stays `whish` — the operator-facing method and every stored
 * `provider='whish'` row keep meaning "a Whish deposit" — but the code behind
 * it talks to RIVAL, Loadless's own payments platform, where Whish is
 * integrated once. This registry is the seam that made that swap one file:
 * `TransactionsService` still asks "start a payment on this key" and never
 * learns which platform answered. A future rail Rival adds (OMT, USDT) is a
 * case here, not a change to the deposit flow.
 *
 * The key → provider mapping is deliberately explicit rather than dynamic: a
 * gateway is a money path, and "which code moves this client's money" should be
 * greppable rather than resolved at runtime from a database string.
 */
@Injectable()
export class PaymentGateways {
  constructor(
    private readonly rival: RivalClient,
    private readonly rivalConfig: RivalConfigService,
  ) {}

  /**
   * Is the provider behind this method usable on this deployment?
   *
   * Async now — the answer lives in `rival_settings`, not the environment,
   * because the operator can enable and disable the platform connection from
   * the settings screen without a deploy.
   *
   * An UNKNOWN key answers false rather than throwing. Callers pair this with
   * `isImplemented`, so an unknown key never reaches here as a gateway — but if
   * one did, throwing would take down the whole method list for every client
   * because of a single bad row.
   */
  async isConfigured(key: string): Promise<boolean> {
    switch (key) {
      case 'whish':
        return this.rivalConfig.isEnabled();
      default:
        return false;
    }
  }

  /**
   * Does a gateway implementation EXIST for this key, credentials aside?
   *
   * Distinct from `isConfigured`, and the difference is the whole point:
   *
   *   isImplemented  is there code that can talk to this provider?  — a fact
   *                  about the BUILD, true on every deployment.
   *   isConfigured   can THIS deployment reach it?                  — a fact
   *                  about the CONFIGURATION, false without a Rival key.
   *
   * The FLOW is decided by the first, never the second. A method must not fall
   * back to the manual flow because a deployment is missing credentials — that
   * would hand a client bank-transfer instructions for a provider that has no
   * bank account, which is the fabricated-payment-details failure this codebase
   * treats as its most expensive.
   *
   * An unconfigured gateway stays a gateway and is simply not offered.
   */
  isImplemented(key: string): boolean {
    return key === 'whish';
  }

  /**
   * Start a hosted payment and return the URL to send the client to, plus
   * Rival's `externalId` — the identifier every inbound event and poll will
   * address this payment by. The caller stores it on the row immediately.
   *
   * `idempotencyKey` is our own transaction reference, so a retried request
   * converges on ONE Rival payment rather than creating a second. No callback
   * URLs: Rival owns the provider relationship, and it tells us what happened
   * through the signed CRM webhook and the poll backstop.
   *
   * Throws for an unknown key — unlike `isConfigured`. By the time this is
   * called the method has already passed `assertUsable`, so an unimplemented
   * gateway here is a real failure that must not be swallowed into a silent
   * no-op that leaves a client staring at a pending deposit nobody can pay.
   */
  async startPayment(
    key: string,
    input: {
      amount: string;
      currency: string;
      invoice: string;
      idempotencyKey: string;
      /** Optional: omitted when the portal address is not payer-reachable. */
      successRedirectUrl?: string;
      failureRedirectUrl?: string;
    },
  ): Promise<{ paymentUrl: string; rivalExternalId: string }> {
    switch (key) {
      case 'whish': {
        const payment = await this.rival.createWhishPayment(input);
        if (!payment.collectUrl) {
          /*
           * Created, but Rival could not mint the hosted page ("linkless
           * orphan" in its vocabulary — Whish gave no usable answer). The
           * payment EXISTS at Rival under our idempotency key, so this is
           * indeterminate, not failed: the caller keeps the row pending and
           * tags it with the externalId, and the poller re-creates with the
           * same key — which Rival resolves to this payment and re-mints.
           */
          throw new PaymentIndeterminateError(
            'The payment platform recorded the deposit but could not produce a payment page. ' +
              'It will be retried automatically — do not create a second deposit.',
            { rivalExternalId: payment.externalId },
          );
        }
        return { paymentUrl: payment.collectUrl, rivalExternalId: payment.externalId };
      }
      default:
        throw new ValidationError(`No payment gateway is implemented for ${key}.`);
    }
  }

  /**
   * Ask Rival what actually happened to a payment.
   *
   * Takes the RIVAL externalId, not our reference — Rival's read is addressed
   * by its own identifier, which the caller stored at create.
   *
   * `settled` is the caller's decision point: only `PAID` and `FAILED` are
   * final. Rival's `PENDING` covers "the client tried and failed but the link
   * is still payable" — Rival already absorbed Whish's failed-attempt nuance —
   * so its `FAILED`, unlike raw Whish's, genuinely is the end of the payment.
   *
   * `needsAttention` is surfaced and NEVER auto-credited: it means Rival saw
   * the money and could not settle its own side, which is Rival's incident to
   * resolve; crediting on it would move client money on an unsettled fact.
   */
  async checkPayment(
    key: string,
    rivalExternalId: string,
  ): Promise<{
    settled: boolean;
    paid: boolean;
    rawStatus: string;
    needsAttention: boolean;
    /**
     * What the PROVIDER says the payment is for, so the caller can check it
     * against what this system is about to credit.
     *
     * Carried rather than discarded because the provider's own answer is the
     * only independent statement of the amount we have, and crediting a figure
     * nobody re-checked is how a system pays out money nobody paid in.
     * Optional: a gateway that cannot report an amount must not be forced to
     * invent one — the caller treats absent as "no second opinion available".
     */
    amount?: string;
    currency?: string;
  }> {
    switch (key) {
      case 'whish': {
        const payment = await this.rival.getWhishPayment(rivalExternalId);
        return {
          settled: payment.status === 'PAID' || payment.status === 'FAILED',
          paid: payment.status === 'PAID',
          rawStatus: payment.status,
          needsAttention: payment.needsAttention,
          amount: payment.amount,
          currency: payment.currency,
        };
      }
      default:
        throw new ValidationError(`No payment gateway is implemented for ${key}.`);
    }
  }
}
