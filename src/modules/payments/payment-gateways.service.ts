import { Injectable } from '@nestjs/common';
import { PaymentIndeterminateError, ValidationError } from '../../common/errors/domain-errors';
import { RivalClient, RIVAL_MONEY_SCALE } from './rival/rival.client';
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
   * The number of decimal places this rail settles EXACTLY, in BOTH directions,
   * or null when the key is not a rail this build moves money through.
   *
   * A transfer is bounded by two scales and only one of them was ever checked.
   * `currencies.decimals` says what the OPERATOR declares the currency holds and
   * is editable from 0 to 8; this says what the PROVIDER can actually handle.
   * Where the currency allows more places than the rail, the difference is money
   * that changes hands without being recorded — and it is the SAME 2 either way,
   * because `quantiseIn` and `quantiseOut` both round to `RIVAL_MONEY_SCALE`:
   *
   *   money OUT  the client is debited the full amount and the rail sends the
   *              rounded one. The remainder is kept.
   *   money IN   the link is created at the rounded amount and the wallet is
   *              credited `tx.amount`. The client pays one figure and is
   *              credited another — and because money-in rounds to NEAREST
   *              rather than down, that can credit MORE than was collected.
   *
   * One method rather than a payout/deposit pair precisely because the number is
   * one number: splitting it would invite the two to drift, and a rail that
   * genuinely differed by direction would be a new fact worth stating loudly
   * rather than a second constant nobody compares.
   *
   * Null means "no rail, no extra constraint" — a manual deposit or a desk-paid
   * withdrawal is settled by a human who can handle whatever the currency
   * expresses.
   */
  settlementScale(key: string): number | null {
    return key === 'whish' ? RIVAL_MONEY_SCALE : null;
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
