import { button, card, esc, p, pRich, panel, type RenderedEmail } from './layout';

/**
 * Money an operator placed into a client's wallet by hand.
 *
 * ## Why this mail exists at all
 *
 * A balance that changes with no explanation is indistinguishable from a bug,
 * and on a money product the client's first assumption is the expensive one. A
 * manual credit has no provider receipt and no deposit the client initiated, so
 * without this there is nothing anywhere telling them why the number moved.
 *
 * ## The REASON is the body of the mail, not a footnote
 *
 * It is the only thing that makes the credit make sense — "goodwill adjustment
 * for the failed 4 August transfer" is an answer; "your balance increased" is a
 * support ticket. The operator is required to supply one for exactly this
 * reason, so it is rendered in a panel rather than buried in a sentence.
 *
 * ## What it deliberately does NOT say
 *
 * Nothing about who credited it. The client cannot act on an operator's name,
 * and putting staff identities in outbound mail is a disclosure decision nobody
 * has made — the audit log has the name for anyone entitled to ask.
 */
export function walletCredit(
  firstName: string,
  amount: string,
  currency: string,
  reason: string,
  portalUrl: string,
): RenderedEmail {
  /*
   * The amount is interpolated as the STRING it arrived as, never reformatted.
   * It is a NUMERIC(28,8) decimal string (§6.1); running it through
   * `Number()` or `toLocaleString` here to prettify it would be the one place
   * in the system where a balance is rounded on its way to the person who owns
   * it.
   */
  const money = `${esc(amount)} ${esc(currency)}`;

  return {
    subject: 'Funds Added to Your Wallet — OxShare',
    html: card(`        <h2 style="color: #047857; margin-top: 0;">
          Funds have been added to your wallet
        </h2>
${p(`Hello ${esc(firstName) || 'Valued Client'},`)}
${pRich(`<strong>${money}</strong> has been credited to your OxShare wallet by our team.`)}
${panel(`<strong>Reason:</strong> ${esc(reason)}`)}
${p('The funds are available now. You can see the credit on your transactions page alongside your other activity.')}
${button(portalUrl, 'Go to Portal')}`),
  };
}
