import { button, card, esc, p, pRich, type RenderedEmail } from './layout';
import { displayMoney } from '../../../common/money-display';

/**
 * The deposit verdict — credited, or failed with what to do next.
 *
 * FR-CORE-07's own words: a deposit "credits the relevant wallet on
 * confirmation, with the client notified of the outcome." This is that
 * notification's email half; the in-app row is written in the settlement
 * transaction itself.
 *
 * The heading colour carries the outcome before a word is read — the same
 * arrangement as `withdrawalDecision`, and for the same reason.
 *
 * The failure copy does NOT speculate about why: the gateway reported the
 * payment unpaid, and inventing a reason ("your card was declined") states
 * something this system does not know. What the reader can act on is the next
 * step — try again, or ask support — so that is what the sentence says.
 */
export function depositOutcome(
  firstName: string,
  outcome: 'succeeded' | 'failed',
  amount: string,
  currency: string,
  portalUrl: string,
): RenderedEmail {
  const succeeded = outcome === 'succeeded';
  // Formatted for a reader, escaped because it is composed into markup — see
  // `displayMoney`. This read "100.00000000 USD" where the portal says "$100.00".
  const money = esc(displayMoney(amount, currency));

  /*
   * `pRich` for the two sentences carrying `<strong>`, `p` for the one that does
   * not. `p()` escapes its input, so passing markup to it printed the tags
   * literally — the same bug the withdrawal template had, in both branches here.
   */
  const body = succeeded
    ? pRich(
        `Your deposit of <strong>${money}</strong> has been confirmed and credited to your wallet. ` +
          `The funds are available now.`,
      )
    : [
        pRich(
          `Your deposit of <strong>${money}</strong> could not be completed and no funds were taken by OxShare.`,
        ),
        p(
          `You can start a new deposit from the portal whenever you are ready. If you believe you ` +
            `were charged, contact support with the date and amount and we will trace it.`,
        ),
      ].join('\n');

  return {
    subject: succeeded ? 'Deposit Confirmed — OxShare' : 'Deposit Failed — OxShare',
    html: card(`        <h2 style="color: ${succeeded ? '#047857' : '#b42318'}; margin-top: 0;">
          ${succeeded ? 'Your deposit has been credited' : 'Your deposit did not complete'}
        </h2>
${p(`Hello ${esc(firstName) || 'Valued Client'},`)}
${body}
${button(portalUrl, 'Go to Portal')}`),
  };
}
