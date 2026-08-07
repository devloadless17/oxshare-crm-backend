import { button, card, esc, p, panel, type RenderedEmail } from './layout';

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
 */
export function withdrawalDecision(
  firstName: string,
  decision: 'paid' | 'rejected',
  amount: string,
  currency: string,
  portalUrl: string,
  reason?: string,
): RenderedEmail {
  const paid = decision === 'paid';
  const money = `${esc(amount)} ${esc(currency)}`;

  const body = paid
    ? p(
        `Your withdrawal of <strong>${money}</strong> has been processed and sent to your nominated destination.`,
      )
    : [
        p(`Your withdrawal of <strong>${money}</strong> could not be processed.`),
        reason ? panel(`<strong>Reason:</strong> ${esc(reason)}`) : '',
        p(
          `The ${money} has been returned to your balance, and you can submit a new request whenever you are ready.`,
        ),
      ]
        .filter(Boolean)
        .join('\n');

  return {
    subject: paid ? 'Withdrawal Sent — OxShare' : 'Withdrawal Declined — OxShare',
    html: card(`        <h2 style="color: ${paid ? '#047857' : '#b42318'}; margin-top: 0;">
          ${paid ? 'Your withdrawal has been sent' : 'Your withdrawal was declined'}
        </h2>
${p(`Hello ${esc(firstName) || 'Valued Client'},`)}
${body}
${button(portalUrl, 'Go to Portal')}`),
  };
}
