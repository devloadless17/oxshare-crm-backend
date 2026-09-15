import { button, card, esc, p, pRich, panel, type RenderedEmail } from './layout';
import { displayMoney } from '../../../common/money-display';

/**
 * The withdrawal verdict — sent, or declined with the reason and what happens
 * to the money.
 *
 * The heading colour carries the outcome before a word is read, which is why
 * this composes its own heading markup rather than using `layout`'s — the same
 * arrangement as `kycDecision`, and for the same reason.
 *
 * ## The refund sentence is not decoration
 *
 * A declined withdrawal debited the balance when it was requested, so the
 * client's balance moved twice: down at request, back up at the refusal. The
 * previous version of this template said "the reserved funds have been returned
 * to your available balance", which described the HOLD model that came before
 * and is now wrong in a way the reader can check — they would look at a balance
 * that never visibly changed and conclude the refund had not happened.
 *
 * So the wording says the amount has been RETURNED, and the reason is always
 * present: a decline the client cannot act on generates a support ticket and a
 * second identical request.
 *
 * ## One template for all three lifecycle messages, deliberately
 *
 * 'approved' joined 'paid' and 'rejected' rather than getting its own file:
 * the three sentences describe consecutive states of ONE request, and keeping
 * them side by side is what stops "approved and being processed" drifting out
 * of step with "has been sent". Approval says money has NOT moved yet —
 * FR-CORE-08's outcome email still follows at settlement.
 */
export function withdrawalDecision(
  firstName: string,
  decision: 'approved' | 'paid' | 'rejected',
  amount: string,
  currency: string,
  portalUrl: string,
  reason?: string,
): RenderedEmail {
  /*
   * FORMATTED, not the raw column value — see `displayMoney`. This read
   * "11.00000000 USD" in a client's inbox while the portal showed them "$11.00"
   * for the same withdrawal. Still escaped: the currency code reaches here from
   * a database row, and a template that escapes everything except the one field
   * somebody will eventually make editable is a template with a hole in it.
   */
  const money = esc(displayMoney(amount, currency));

  const heading = {
    approved: 'Your withdrawal has been approved',
    paid: 'Your withdrawal has been sent',
    rejected: 'Your withdrawal was declined',
  }[decision];
  const headingColor = decision === 'rejected' ? '#b42318' : '#047857';

  /*
   * ⚠️ `pRich`, NOT `p` — and using `p` here was a live bug in the client's
   * inbox.
   *
   * `p()` escapes everything it is given, which is the correct default and
   * exactly wrong for a string that already contains markup: the approved and
   * paid messages arrived reading literally
   * "Your withdrawal of <strong>11.00000000 USD</strong> has been approved",
   * tags and all. `pRich` takes pre-composed HTML and the caller escapes its own
   * values — which is what `money` above does.
   *
   * The rejected branch below already used `pRich` correctly, which is why only
   * two of the three messages were affected and the bug survived.
   */
  const body =
    decision === 'approved'
      ? pRich(
          `Your withdrawal of <strong>${money}</strong> has been approved and is being processed. ` +
            `You will receive a confirmation email once the funds have been sent.`,
        )
      : decision === 'paid'
        ? pRich(
            `Your withdrawal of <strong>${money}</strong> has been processed and sent to your nominated destination.`,
          )
        : [
            pRich(`Your withdrawal of <strong>${money}</strong> could not be processed.`),
            reason ? panel(`<strong>Reason:</strong> ${esc(reason)}`) : '',
            p(
              `The ${money} has been returned to your balance, and you can submit a new request whenever you are ready.`,
            ),
          ]
            .filter(Boolean)
            .join('\n');

  const subject = {
    approved: 'Withdrawal Approved — OxShare',
    paid: 'Withdrawal Sent — OxShare',
    rejected: 'Withdrawal Declined — OxShare',
  }[decision];

  return {
    subject,
    html: card(`        <h2 style="color: ${headingColor}; margin-top: 0;">
          ${heading}
        </h2>
${p(`Hello ${firstName || 'Valued Client'},`)}
${body}
${button(portalUrl, 'Go to Portal')}`),
  };
}
