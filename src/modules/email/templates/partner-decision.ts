import type { Locale } from '../../../common/i18n/locale';
import {
  button,
  buttonAr,
  esc,
  greetingAr,
  layout,
  layoutAr,
  ltr,
  p,
  pAr,
  panel,
  panelAr,
  type RenderedEmail,
} from './layout';

/**
 * The partner-application verdict — approved with a referral code, or rejected
 * with what went wrong.
 *
 * Modelled on `kyc-decision.ts` deliberately: it is the same shape of message
 * (a client asked for something, a human decided, the client needs to know what
 * to do next), and two decision emails that read differently for no reason make
 * a product feel assembled by strangers.
 *
 * ## An approval carries the referral code
 *
 * Because it is the whole point of being approved, and because the alternative
 * — "you have been approved, sign in to find out what that means" — spends the
 * one moment of attention this email will ever get. The code is safe to email:
 * it is a public identifier meant to be shared, not a credential.
 *
 * ## A rejection ALWAYS carries the reason
 *
 * Same rule the KYC template follows. "Your application was not successful"
 * with no reason is a message the recipient cannot act on, and the applicant
 * will simply re-apply unchanged — which costs a reviewer the same decision a
 * second time.
 */
export function partnerDecision(
  firstName: string,
  decision: 'approved' | 'rejected',
  portalUrl: string,
  options: { referralCode?: string; reason?: string } = {},
  locale: Locale = 'en',
): RenderedEmail {
  if (locale === 'ar') return partnerDecisionAr(firstName, decision, portalUrl, options);
  const approved = decision === 'approved';

  const body = approved
    ? [
        p(
          'Your application to join the OxShare partner programme has been approved. You can now introduce clients and track them from your partner dashboard.',
        ),
        options.referralCode
          ? panel(
              `<strong>Your referral code:</strong> ${esc(options.referralCode)}<br />` +
                `<span style="font-size: 12px;">Share this code, or the link on your partner page, so clients you introduce are attributed to you.</span>`,
            )
          : '',
      ]
        .filter(Boolean)
        .join('\n')
    : [
        p('Your application to join the OxShare partner programme was not approved this time.'),
        panel(`<strong>Reason:</strong> ${esc(options.reason)}`),
        p('You are welcome to apply again once that has been addressed.'),
      ].join('\n');

  return {
    subject: approved
      ? 'You are now an OxShare partner'
      : 'Your OxShare partner application — OxShare',
    html: layout(
      approved ? 'Welcome to the partner programme' : 'Your partner application',
      [
        p(`Hello ${firstName || 'Valued Client'},`),
        body,
        button(`${portalUrl}/partner`, 'Go to Portal'),
      ].join('\n'),
    ),
  };
}

function partnerDecisionAr(
  firstName: string,
  decision: 'approved' | 'rejected',
  portalUrl: string,
  options: { referralCode?: string; reason?: string },
): RenderedEmail {
  const approved = decision === 'approved';

  const body = approved
    ? [
        pAr(
          'تمت الموافقة على طلب انضمامك إلى برنامج الشركاء في OXShare. يمكنك الآن إحالة ' +
            'العملاء ومتابعتهم من لوحة تحكم الشريك.',
        ),
        options.referralCode
          ? panelAr(
              `<strong>رمز الإحالة الخاص بك:</strong> ${ltr(options.referralCode)}<br />` +
                '<span style="font-size: 12px;">شارك هذا الرمز، أو الرابط الموجود في صفحة الشريك، ' +
                'لكي يُنسَب إليك العملاء الذين تُحيلهم.</span>',
            )
          : '',
      ]
        .filter(Boolean)
        .join('\n')
    : [
        pAr('لم تتم الموافقة على طلب انضمامك إلى برنامج الشركاء في OXShare هذه المرة.'),
        panelAr(`<strong>السبب:</strong> ${esc(options.reason)}`),
        pAr('يسعدنا أن تتقدّم بطلب جديد بعد معالجة ذلك.'),
      ].join('\n');

  return {
    subject: approved ? 'أصبحت الآن شريكاً في OXShare' : 'طلب انضمامك إلى برنامج الشركاء — OXShare',
    html: layoutAr(
      approved ? 'مرحباً بك في برنامج الشركاء' : 'طلب الانضمام إلى برنامج الشركاء',
      [greetingAr(firstName), body, buttonAr(`${portalUrl}/partner`, 'الانتقال إلى البوابة')].join(
        '\n',
      ),
    ),
  };
}
