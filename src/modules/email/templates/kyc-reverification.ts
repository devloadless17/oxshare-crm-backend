import type { Locale } from '../../../common/i18n/locale';
import {
  button,
  buttonAr,
  esc,
  greetingAr,
  layout,
  layoutAr,
  p,
  pAr,
  panel,
  panelAr,
  type RenderedEmail,
} from './layout';

/**
 * "Please update your verification" — sent when a reviewer returns an APPROVED
 * verification to the client (`KycService.requestReverification`).
 *
 * Deliberately NOT the rejection email. The client did nothing wrong: a detail
 * changed — a new passport, a move abroad — and the broker needs it verified
 * again. "Your application was rejected" reads as a verdict on them, and a
 * client who reads it that way calls support instead of updating two fields.
 *
 * It says what to redo, why, and — because deposits and withdrawals pause until
 * the review is done — says that plainly too, so the pause is not discovered
 * at the moment they try to withdraw.
 */
export function kycReverification(
  firstName: string,
  reason: string,
  items: readonly string[],
  portalUrl: string,
  locale: Locale = 'en',
): RenderedEmail {
  if (locale === 'ar') return kycReverificationAr(firstName, reason, items, portalUrl);
  return {
    subject: 'Please update your verification — OxShare',
    html: layout(
      'Please update your verification',
      [
        p(`Hello ${firstName || 'Valued Client'},`),
        p('Our verification team needs you to update your identity verification.'),
        panel(`<strong>Why:</strong> ${esc(reason)}`),
        items.length > 0 ? p(`Please update: ${items.join(', ')}.`) : '',
        p(
          'Deposits and withdrawals are paused until your updated verification is reviewed. ' +
            'Everything else on your account stays as it is.',
        ),
        button(`${portalUrl}/kyc`, 'Update your verification'),
      ]
        .filter(Boolean)
        .join('\n'),
    ),
  };
}

function kycReverificationAr(
  firstName: string,
  reason: string,
  items: readonly string[],
  portalUrl: string,
): RenderedEmail {
  return {
    subject: 'يُرجى تحديث بيانات التحقق من هويتك — OXShare',
    html: layoutAr(
      'يُرجى تحديث بيانات التحقق من هويتك',
      [
        greetingAr(firstName),
        pAr('يحتاج فريق التحقق لدينا إلى أن تُحدِّث بيانات التحقق من هويتك.'),
        panelAr(`<strong>السبب:</strong> ${esc(reason)}`),
        items.length > 0 ? pAr(`يُرجى تحديث: ${items.join('، ')}.`) : '',
        pAr(
          'ستتوقف عمليات الإيداع والسحب مؤقتاً إلى حين مراجعة بيانات التحقق المحدَّثة. ' +
            'أما بقية خدمات حسابك فتبقى كما هي.',
        ),
        buttonAr(`${portalUrl}/kyc`, 'تحديث بيانات التحقق'),
      ]
        .filter(Boolean)
        .join('\n'),
    ),
  };
}
