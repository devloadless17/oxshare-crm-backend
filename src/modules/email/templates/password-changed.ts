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
 * "Your password was changed" — the warning that reaches the owner while they
 * can still act (13 Oct 2026).
 *
 * Sent after a change on the profile and after a completed reset, never for the
 * first password a client created by staff chooses (nothing was "changed"). The
 * one action it offers is the reset: somebody who did not change it is locked
 * out by whoever did, and a reset link to this mailbox is the way back in. It
 * names no device or address — this is the security notice, not an audit log.
 */
export function passwordChanged(
  firstName: string,
  forgotPasswordUrl: string,
  locale: Locale = 'en',
): RenderedEmail {
  if (locale === 'ar') return passwordChangedAr(firstName, forgotPasswordUrl);
  return {
    subject: 'Your OxShare password was changed',
    html: layout(
      'Your password was changed',
      [
        p(`Hello ${firstName || 'Valued Client'},`),
        p('The password for your OxShare account was just changed.'),
        p('If this was you, there is nothing else to do.'),
        p('If it was not you, reset your password now to take the account back:'),
        button(forgotPasswordUrl, 'Reset Password'),
        fine('For your security, every other device was signed out when the password changed.'),
      ].join('\n'),
    ),
  };
}

function passwordChangedAr(firstName: string, forgotPasswordUrl: string): RenderedEmail {
  return {
    subject: 'تم تغيير كلمة مرور حسابك في OXShare',
    html: layoutAr(
      'تم تغيير كلمة المرور',
      [
        pAr(`مرحباً ${firstName || 'عميلنا العزيز'}،`),
        pAr('تم للتو تغيير كلمة مرور حسابك في OXShare.'),
        pAr('إذا كنت أنت من قام بذلك، فلا حاجة لأي إجراء آخر.'),
        pAr('إذا لم تكن أنت، فأعد تعيين كلمة المرور الآن لاستعادة حسابك:'),
        buttonAr(forgotPasswordUrl, 'إعادة تعيين كلمة المرور'),
        fineAr('حرصاً على أمانك، تم تسجيل الخروج من جميع الأجهزة الأخرى عند تغيير كلمة المرور.'),
      ].join('\n'),
    ),
  };
}
