import type { Locale } from '../../../common/i18n/locale';
import {
  button,
  buttonAr,
  card,
  cardAr,
  esc,
  greetingAr,
  headingAr,
  ltr,
  p,
  pAr,
  pRich,
  pRichAr,
  panel,
  panelAr,
  type RenderedEmail,
} from './layout';

/**
 * The credentials for a trading account that has just been opened.
 *
 * ## This mail is the ONLY delivery
 *
 * MT5 returns the master and investor passwords once, at creation, and nothing
 * stores them. They are deliberately absent from the API response on both the
 * admin and the portal path, so if this mail does not arrive there is no second
 * copy anywhere — the account has to be given a new password by an operator.
 *
 * That is the point rather than a limitation. The account's owner is the only
 * person who should ever hold its trading password, and an API response is read
 * by whoever pressed the button — which on the admin path is a member of staff,
 * and on the portal path is a browser that may not be the client's.
 *
 * ## Two passwords, and the difference matters
 *
 * The MASTER password trades. The INVESTOR password is read-only: it shows
 * positions and history and cannot place an order. Clients hand the second one
 * to signal providers, account managers and analysts, and hand over the first
 * one by mistake when nobody explains the difference — so this explains it,
 * rather than listing two similar-looking strings and leaving them to guess.
 */
export function tradingAccountOpened(
  firstName: string,
  login: string,
  environment: 'live' | 'demo',
  currency: string,
  leverage: number,
  masterPassword: string,
  investorPassword: string,
  portalUrl: string,
  /** The label the client chose, when they chose one. */
  accountName?: string,
  /** What the account actually holds — a funded demo, or nothing. */
  balance?: string,
  locale: Locale = 'en',
): RenderedEmail {
  if (locale === 'ar') {
    return tradingAccountOpenedAr(
      firstName,
      login,
      environment,
      currency,
      leverage,
      masterPassword,
      investorPassword,
      portalUrl,
      accountName,
      balance,
    );
  }
  const kind = environment === 'live' ? 'live' : 'demo';

  return {
    subject: `Your ${kind} trading account ${esc(login)} is ready — OxShare`,
    html: card(`        <h2 style="color: #047857; margin-top: 0;">
          Your ${esc(kind)} trading account is ready
        </h2>
${p(`Hello ${firstName || 'Valued Client'},`)}
${p(
  environment === 'live'
    ? 'Your live trading account has been opened. It holds real money once you fund it.'
    : 'Your demo trading account has been opened. It holds practice money, so you can trade it without risk.',
)}
${panel(
  // The client's own label first when they gave one: it is how they will refer
  // to this account, and a mail that opens with a number they have never seen
  // is harder to place than one that opens with the name they typed.
  (accountName ? `<strong>Name:</strong> ${esc(accountName)}<br>` : '') +
    `<strong>Login:</strong> ${esc(login)}<br>` +
    `<strong>Currency:</strong> ${esc(currency)}<br>` +
    `<strong>Leverage:</strong> 1:${esc(String(leverage))}` +
    // Only when there IS one. "Balance: 0.00" on a live account the client is
    // about to fund reads as a problem rather than a fact.
    (balance && Number.parseFloat(balance) > 0
      ? `<br><strong>Starting balance:</strong> ${esc(balance)} ${esc(currency)}`
      : ''),
)}
${pRich('<strong>Your passwords</strong>')}
${panel(
  `<strong>Master password:</strong> <code>${esc(masterPassword)}</code><br>` +
    '<span style="color:#6b7280;">Full access — places trades and manages the account.</span>' +
    '<br><br>' +
    `<strong>Investor password:</strong> <code>${esc(investorPassword)}</code><br>` +
    '<span style="color:#6b7280;">Read-only — shows positions and history but cannot trade. ' +
    'This is the one to share if somebody needs to watch your account.</span>',
)}
${pRich(
  'Please save these somewhere safe and delete this email. <strong>We do not keep a copy</strong> — ' +
    'if you lose them, you can reset them from the portal and we will email you a new pair.',
)}
${p('Never share your master password. Nobody at OxShare will ever ask you for it.')}
${button(portalUrl, 'Go to Portal')}`),
  };
}

/** Both passwords, explained, in Arabic — shared with the reset mail. */
export function passwordsPanelAr(masterPassword: string, investorPassword: string): string {
  return panelAr(
    `<strong>كلمة المرور الرئيسية:</strong> <code dir="ltr" style="unicode-bidi: isolate;">${esc(masterPassword)}</code><br>` +
      '<span style="color:#6b7280;">وصول كامل — لتنفيذ الصفقات وإدارة الحساب.</span>' +
      '<br><br>' +
      `<strong>كلمة مرور المستثمر:</strong> <code dir="ltr" style="unicode-bidi: isolate;">${esc(investorPassword)}</code><br>` +
      '<span style="color:#6b7280;">للقراءة فقط — تعرض الصفقات والسجل لكنها لا تسمح بالتداول. ' +
      'هذه هي كلمة المرور التي يمكنك مشاركتها إذا احتاج أحد إلى متابعة حسابك.</span>',
  );
}

function tradingAccountOpenedAr(
  firstName: string,
  login: string,
  environment: 'live' | 'demo',
  currency: string,
  leverage: number,
  masterPassword: string,
  investorPassword: string,
  portalUrl: string,
  accountName?: string,
  balance?: string,
): RenderedEmail {
  const kind = environment === 'live' ? 'الحقيقي' : 'التجريبي';

  return {
    subject: `حساب التداول ${kind} ${esc(login)} جاهز — OXShare`,
    html: cardAr(`${headingAr(`حساب التداول ${kind} الخاص بك جاهز`, '#047857')}
${greetingAr(firstName)}
${pAr(
  environment === 'live'
    ? 'تم فتح حساب التداول الحقيقي الخاص بك. سيحتوي على أموال حقيقية بمجرد أن تموّله.'
    : 'تم فتح حساب التداول التجريبي الخاص بك. يحتوي على أموال افتراضية للتدريب، لذا يمكنك التداول عليه دون أي مخاطرة.',
)}
${panelAr(
  (accountName ? `<strong>الاسم:</strong> ${esc(accountName)}<br>` : '') +
    `<strong>رقم الدخول:</strong> ${ltr(login)}<br>` +
    `<strong>العملة:</strong> ${ltr(currency)}<br>` +
    `<strong>الرافعة المالية:</strong> ${ltr(`1:${String(leverage)}`)}` +
    (balance && Number.parseFloat(balance) > 0
      ? `<br><strong>الرصيد الافتتاحي:</strong> ${ltr(`${balance} ${currency}`)}`
      : ''),
)}
${pRichAr('<strong>كلمات المرور الخاصة بك</strong>')}
${passwordsPanelAr(masterPassword, investorPassword)}
${pRichAr(
  'يُرجى حفظها في مكان آمن ثم حذف هذه الرسالة. <strong>نحن لا نحتفظ بنسخة منها</strong> — ' +
    'وإذا فقدتها، يمكنك إعادة تعيينها من البوابة وسنرسل إليك كلمتي مرور جديدتين عبر البريد الإلكتروني.',
)}
${pAr('لا تشارك كلمة المرور الرئيسية مع أي شخص. لن يطلبها منك أحد في OXShare أبداً.')}
${buttonAr(portalUrl, 'الانتقال إلى البوابة')}`),
  };
}
