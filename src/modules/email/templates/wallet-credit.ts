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
  panel,
  panelAr,
  type RenderedEmail,
} from './layout';
import { displayMoney } from '../../../common/money-display';

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
  locale: Locale = 'en',
): RenderedEmail {
  if (locale === 'ar') return walletCreditAr(firstName, amount, currency, reason, portalUrl);
  /*
   * FORMATTED for display, and the rule this replaces is still honoured.
   *
   * The previous note refused to reformat, on the grounds that `Number()` or
   * `toLocaleString` here "would be the one place in the system where a balance
   * is rounded on its way to the person who owns it". The COERCION half of that
   * is exactly right and is why neither is used: `displayMoney` rounds with
   * decimal.js and never converts to a float.
   *
   * What the rule got wrong is the conclusion. Refusing to format did not
   * protect the client, it emailed them "500.00000000 USD" while their wallet
   * screen said "$500.00" — two renderings of one credit, and the reader has to
   * decide whether they match. The ledger keeps all eight places; this is the
   * last inch before a sentence.
   */
  const money = esc(displayMoney(amount, currency));

  return {
    subject: 'Funds Added to Your Wallet — OxShare',
    html: card(`        <h2 style="color: #047857; margin-top: 0;">
          Funds have been added to your wallet
        </h2>
${p(`Hello ${firstName || 'Valued Client'},`)}
${pRich(`<strong>${money}</strong> has been credited to your OxShare wallet by our team.`)}
${panel(`<strong>Reason:</strong> ${esc(reason)}`)}
${p('The funds are available now. You can see the credit on your transactions page alongside your other activity.')}
${button(portalUrl, 'Go to Portal')}`),
  };
}

function walletCreditAr(
  firstName: string,
  amount: string,
  currency: string,
  reason: string,
  portalUrl: string,
): RenderedEmail {
  const money = ltrHtml(esc(displayMoney(amount, currency)));
  return {
    subject: 'تمت إضافة أموال إلى محفظتك — OXShare',
    html: cardAr(`${headingAr('تمت إضافة أموال إلى محفظتك', '#047857')}
${greetingAr(firstName)}
${pRichAr(`أضاف فريقنا مبلغ <strong>${money}</strong> إلى محفظتك في OXShare.`)}
${panelAr(`<strong>السبب:</strong> ${esc(reason)}`)}
${pAr('الأموال متاحة الآن. يمكنك الاطلاع على هذه العملية في صفحة المعاملات إلى جانب نشاطك الآخر.')}
${buttonAr(portalUrl, 'الانتقال إلى البوابة')}`),
  };
}

/**
 * The REASON line of the hourly commission / rebate summary mail — server
 * composed, so the server writes it in the recipient's language. The English is
 * exactly what `CommissionService` wrote before it moved here.
 */
export function commissionSummaryReason(
  kind: 'commission' | 'rebate',
  count: number,
  locale: Locale = 'en',
): string {
  if (locale !== 'ar') {
    return kind === 'rebate'
      ? `Trading rebate on ${count} closed trade(s)`
      : `Partner commission on ${count} closed trade(s)`;
  }
  const trades = {
    zero: `${count} صفقة مغلقة`,
    one: 'صفقة مغلقة واحدة',
    two: 'صفقتين مغلقتين',
    few: `${count} صفقات مغلقة`,
    many: `${count} صفقة مغلقة`,
    other: `${count} صفقة مغلقة`,
  }[new Intl.PluralRules('ar').select(count)];
  return kind === 'rebate' ? `عمولة مستردة عن ${trades}` : `عمولة الشريك عن ${trades}`;
}
