import type { Locale } from '../../../common/i18n/locale';
import {
  button,
  buttonAr,
  greetingAr,
  layout,
  layoutAr,
  p,
  pAr,
  type RenderedEmail,
} from './layout';

/**
 * "We corrected details on your verified profile" — sent when a reviewer
 * corrects an APPROVED client's identity (`KycService.correctIdentity`).
 *
 * A verified identity changed by somebody other than its owner must never be
 * silent: the client is the one person who can say "that is not my name". It
 * names WHICH details changed and not their values — the values are the
 * client's to read on their profile, behind their sign-in, not in a mailbox.
 *
 * Nothing to do when it was expected; a clear route when it was not.
 */
export function kycDetailsCorrected(
  firstName: string,
  details: readonly string[],
  portalUrl: string,
  locale: Locale = 'en',
): RenderedEmail {
  if (locale === 'ar') return kycDetailsCorrectedAr(firstName, details, portalUrl);
  return {
    subject: 'We corrected details on your verified profile — OxShare',
    html: layout(
      'Your verified details were corrected',
      [
        p(`Hello ${firstName || 'Valued Client'},`),
        p(
          'Our verification team corrected the following details on your verified profile: ' +
            `${details.join(', ')}. Your verification stays in place.`,
        ),
        p(
          'You can see your details on your profile. If a correction is not right, reply to this ' +
            'email or contact support.',
        ),
        button(`${portalUrl}/profile`, 'View your profile'),
      ].join('\n'),
    ),
  };
}

function kycDetailsCorrectedAr(
  firstName: string,
  details: readonly string[],
  portalUrl: string,
): RenderedEmail {
  return {
    subject: 'صحّحنا بعض البيانات في ملفك الشخصي الموثَّق — OXShare',
    html: layoutAr(
      'تم تصحيح بياناتك الموثَّقة',
      [
        greetingAr(firstName),
        pAr(
          'صحّح فريق التحقق لدينا البيانات التالية في ملفك الشخصي الموثَّق: ' +
            `${details.join('، ')}. يظل التحقق من هويتك سارياً.`,
        ),
        pAr(
          'يمكنك الاطلاع على بياناتك في ملفك الشخصي. إذا كان أي تصحيح غير دقيق، فتواصل مع ' +
            'فريق الدعم.',
        ),
        buttonAr(`${portalUrl}/profile`, 'عرض ملفك الشخصي'),
      ].join('\n'),
    ),
  };
}
