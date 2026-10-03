import type { Locale } from '../../../common/i18n/locale';
import {
  button,
  buttonAr,
  fine,
  fineAr,
  layout,
  layoutAr,
  p,
  pAr,
  type RenderedEmail,
} from './layout';

/**
 * "Set a new password" — the client-facing reset.
 *
 * The expiry is stated in the body on purpose: a link that dies silently reads
 * as a broken product rather than a deliberate limit, and this one is short.
 */
export function passwordReset(resetUrl: string, locale: Locale = 'en'): RenderedEmail {
  if (locale === 'ar') return passwordResetAr(resetUrl);
  return {
    subject: 'Reset Password Request — OxShare',
    html: layout(
      'Password Reset Request',
      [
        p('You requested to reset your password. Click the link below to set a new password.'),
        button(resetUrl, 'Reset Password'),
        fine('This token will expire in 30 minutes.'),
      ].join('\n'),
    ),
  };
}

/**
 * The Arabic twin. It states the REAL lifetime — `requestPasswordReset` issues
 * the token for 30 minutes and `resetPassword` clears it on use — and adds the
 * "not you? nothing changes" line every reset mail owes its reader.
 */
function passwordResetAr(resetUrl: string): RenderedEmail {
  return {
    subject: 'طلب إعادة تعيين كلمة المرور — OXShare',
    html: layoutAr(
      'إعادة تعيين كلمة المرور',
      [
        pAr(
          'تلقّينا طلباً لإعادة تعيين كلمة مرور حسابك في OXShare. اضغط على الزر أدناه لتعيين ' +
            'كلمة مرور جديدة.',
        ),
        buttonAr(resetUrl, 'إعادة تعيين كلمة المرور'),
        fineAr('تنتهي صلاحية هذا الرابط خلال 30 دقيقة، ولا يمكن استخدامه إلا مرة واحدة.'),
        fineAr(
          'إذا لم تطلب إعادة تعيين كلمة المرور، يمكنك تجاهل هذه الرسالة بأمان — ستبقى كلمة ' +
            'مرورك الحالية دون تغيير.',
        ),
      ].join('\n'),
    ),
  };
}
