import { Injectable } from '@nestjs/common';
import { ValidationError } from '../../common/errors/domain-errors';
import { WhishProvider } from './whish.provider';

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
 * ## Why this exists rather than `if (key === 'whish')` at each call site
 *
 * `schema.ts` states the rule: "a screen that branches on `key === 'whish'` has
 * to be edited every time an operator adds a method, which is the thing making
 * these rows data instead of code was meant to avoid." The same applies on the
 * server.
 *
 * So `PaymentMethodsService` asks "is this gateway configured?" and
 * `TransactionsService` asks "is this a gateway at all, and start a payment on
 * it", and neither of them names Whish. Adding a second provider is a case in
 * ONE switch here, not a change to the deposit flow, the method list and the
 * callback route.
 *
 * The key → provider mapping is deliberately explicit rather than dynamic: a
 * gateway is a money path, and "which code moves this client's money" should be
 * greppable rather than resolved at runtime from a database string.
 */
@Injectable()
export class PaymentGateways {
  constructor(private readonly whish: WhishProvider) {}

  /**
   * Is the provider behind this method usable on this deployment?
   *
   * An UNKNOWN key answers false rather than throwing. Callers pair this with
   * `isImplemented`, so an unknown key never reaches here as a gateway — but if
   * one did, throwing would take down the whole method list for every client
   * because of a single bad row.
   */
  isConfigured(key: string): boolean {
    switch (key) {
      case 'whish':
        return this.whish.isConfigured();
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
   *                  about the ENVIRONMENT, false without the keys.
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
   * Start a hosted payment and return the URL to send the client to.
   *
   * Throws for an unknown key — unlike `isConfigured`. By the time this is
   * called the method has already passed `assertUsable`, so an unimplemented
   * gateway here is a real failure that must not be swallowed into a silent
   * no-op that leaves a client staring at a pending deposit nobody can pay.
   */
  async startPayment(
    key: string,
    input: {
      externalId: string;
      amount: string;
      currency: string;
      invoice: string;
      successCallbackUrl: string;
      failureCallbackUrl: string;
      successRedirectUrl: string;
      failureRedirectUrl: string;
    },
  ): Promise<{ paymentUrl: string }> {
    switch (key) {
      case 'whish': {
        const collect = await this.whish.createCollect(input);
        return { paymentUrl: collect.collectUrl };
      }
      default:
        throw new ValidationError(`No payment gateway is implemented for ${key}.`);
    }
  }

  /**
   * Ask the provider what actually happened to a payment.
   *
   * This is what settles a deposit. The callback that prompted the question is
   * an unauthenticated GET and proves nothing; this answer is authoritative.
   *
   * `settled` is the caller's decision point: only `success` and `failed` are
   * final. `pending` means the link is still payable — including after a failed
   * attempt — so a failure callback is NOT the end of a payment.
   */
  async checkPayment(
    key: string,
    externalId: string,
    currency: string,
  ): Promise<{ settled: boolean; paid: boolean; rawStatus: string }> {
    switch (key) {
      case 'whish': {
        const status = await this.whish.getStatus(externalId, currency);
        const paid = status.collectStatus === 'success';
        /*
         * `refunded` counts as settled AND not paid. The money came and went;
         * crediting it would hand a client a balance the operator no longer
         * holds — and leaving it unsettled would have the reconciler chasing it
         * forever.
         */
        const settled =
          status.collectStatus === 'success' ||
          status.collectStatus === 'failed' ||
          status.collectStatus === 'refunded';
        return { settled, paid, rawStatus: status.collectStatus };
      }
      default:
        throw new ValidationError(`No payment gateway is implemented for ${key}.`);
    }
  }
}
