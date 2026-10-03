import type { Locale } from '../../../common/i18n/locale';
import {
  button,
  buttonAr,
  card,
  cardAr,
  esc,
  greetingAr,
  headingAr,
  ltrHtml,
  p,
  pAr,
  pRich,
  pRichAr,
  type RenderedEmail,
} from './layout';
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
  outcome: 'succeeded' | 'failed' | 'rejected',
  amount: string,
  currency: string,
  portalUrl: string,
  /** The desk's reason. Only ever set for `rejected`. */
  reason?: string,
  locale: Locale = 'en',
): RenderedEmail {
  if (locale === 'ar') {
    return depositOutcomeAr(firstName, outcome, amount, currency, portalUrl, reason);
  }
  const succeeded = outcome === 'succeeded';
  const rejected = outcome === 'rejected';
  // Formatted for a reader, escaped because it is composed into markup — see
  // `displayMoney`. This read "100.00000000 USD" where the portal says "$100.00".
  const money = esc(displayMoney(amount, currency));

  /*
   * `pRich` for the two sentences carrying `<strong>`, `p` for the one that does
   * not. `p()` escapes its input, so passing markup to it printed the tags
   * literally — the same bug the withdrawal template had, in both branches here.
   */
  /*
   * ── WHY `rejected` CANNOT REUSE THE `failed` COPY ───────────────────────
   *
   * `failed` says "no funds were taken by OxShare", which is true of a gateway
   * deposit: the payment never completed, so nothing left the client's account.
   *
   * An OFFLINE deposit is the opposite case. The client transferred money
   * somewhere in the world and uploaded a receipt; the desk is refusing the
   * DECLARATION — usually because the receipt is unreadable, does not match, or
   * names an amount that never arrived. Telling that client "no funds were
   * taken" would be the platform denying a payment it may well be holding.
   *
   * So this branch states what was refused, quotes the desk's reason, and tells
   * a client who did send the money what to do about it. It deliberately does
   * NOT promise a refund: nothing was ever debited here, so there is nothing to
   * give back — the money, if it arrived, is a matter for support.
   */
  const rejectedBody = [
    pRich(
      `Your deposit of <strong>${money}</strong> was not accepted, so nothing has been added to ` +
        `your wallet.`,
    ),
    reason ? p(`Reason: ${reason}`) : '',
    /*
     * "Contact support", never "reply to this email". The shared layout signs
     * every message off with "Please do not reply to it", and the From address
     * is a no-reply — so an invitation to reply sends the client's receipt
     * nowhere, at the one moment they are most likely to act on it: they have
     * sent real money and just been refused.
     */
    p(
      `If you have already sent this transfer, contact support with your payment receipt and we ` +
        `will look into it. You can also start a new deposit from the portal.`,
    ),
  ]
    .filter(Boolean)
    .join('\n');

  const body = rejected
    ? rejectedBody
    : succeeded
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
    subject: rejected
      ? 'Deposit Not Accepted — OxShare'
      : succeeded
        ? 'Deposit Confirmed — OxShare'
        : 'Deposit Failed — OxShare',
    html: card(`        <h2 style="color: ${succeeded ? '#047857' : '#b42318'}; margin-top: 0;">
          ${
            succeeded
              ? 'Your deposit has been credited'
              : rejected
                ? 'Your deposit was not accepted'
                : 'Your deposit did not complete'
          }
        </h2>
${p(`Hello ${firstName || 'Valued Client'},`)}
${body}
${button(portalUrl, 'Go to Portal')}`),
  };
}

/**
 * The Arabic twin, under the same rules as the English: a rejected OFFLINE
 * deposit never promises a refund and never says "no funds were taken".
 */
function depositOutcomeAr(
  firstName: string,
  outcome: 'succeeded' | 'failed' | 'rejected',
  amount: string,
  currency: string,
  portalUrl: string,
  reason?: string,
): RenderedEmail {
  const succeeded = outcome === 'succeeded';
  const rejected = outcome === 'rejected';
  const money = ltrHtml(esc(displayMoney(amount, currency)));

  const body = rejected
    ? [
        pRichAr(
          `لم يتم قبول إيداعك بمبلغ <strong>${money}</strong>، لذا لم تُضَف أي أموال إلى محفظتك.`,
        ),
        reason ? pAr(`السبب: ${reason}`) : '',
        pAr(
          'إذا كنت قد أرسلت هذا التحويل بالفعل، فتواصل مع فريق الدعم وأرفق إيصال الدفع وسنتحقق ' +
            'من الأمر. يمكنك أيضاً بدء إيداع جديد من البوابة.',
        ),
      ]
        .filter(Boolean)
        .join('\n')
    : succeeded
      ? pRichAr(
          `تم تأكيد إيداعك بمبلغ <strong>${money}</strong> وإضافته إلى محفظتك. الأموال متاحة الآن.`,
        )
      : [
          pRichAr(
            `تعذّر إتمام إيداعك بمبلغ <strong>${money}</strong>، ولم تقتطع OXShare أي أموال.`,
          ),
          pAr(
            'يمكنك بدء إيداع جديد من البوابة متى كنت مستعداً. إذا كنت تعتقد أن المبلغ قد خُصم ' +
              'منك، فتواصل مع فريق الدعم مع ذكر التاريخ والمبلغ وسنتتبّع العملية.',
          ),
        ].join('\n');

  return {
    subject: rejected
      ? 'لم يتم قبول الإيداع — OXShare'
      : succeeded
        ? 'تم تأكيد الإيداع — OXShare'
        : 'تعذّر إتمام الإيداع — OXShare',
    html: cardAr(`${headingAr(
      succeeded
        ? 'تمت إضافة إيداعك إلى محفظتك'
        : rejected
          ? 'لم يتم قبول إيداعك'
          : 'لم يكتمل إيداعك',
      succeeded ? '#047857' : '#b42318',
    )}
${greetingAr(firstName)}
${body}
${buttonAr(portalUrl, 'الانتقال إلى البوابة')}`),
  };
}
