import type { Locale } from '../../../common/i18n/locale';
import {
  button,
  buttonAr,
  fine,
  fineAr,
  greetingAr,
  layout,
  layoutAr,
  p,
  pAr,
  type RenderedEmail,
} from './layout';

/** How long the welcome link lives — what `ClientCreation` issues it for. */
export const WELCOME_LINK_DAYS = 7;

/**
 * "Your account is ready — choose your password" ("New client", 0211).
 *
 * Sent to a client STAFF created for them, who has never chosen a password.
 * The link is the password-reset link with a longer life: completing it sets
 * their password and confirms this address, exactly as a reset does. It says
 * who opened the account and that messages will come HERE — the client may not
 * have expected an email from us at all — and gives the Portal ID they will be
 * asked for.
 */
export function clientWelcome(
  setPasswordUrl: string,
  firstName: string,
  portalId: number,
  locale: Locale = 'en',
): RenderedEmail {
  if (locale === 'ar') return clientWelcomeAr(setPasswordUrl, firstName, portalId);
  return {
    subject: 'Your OxShare account is ready — choose your password',
    html: layout(
      'Welcome to OxShare',
      [
        p(`Hello ${firstName || 'Valued Client'},`),
        p(
          `Our team has opened an OxShare account for you. Your Portal ID is #${portalId}. ` +
            'Messages about your account will come to this email address.',
        ),
        p('To sign in, choose your password:'),
        button(setPasswordUrl, 'Choose your password'),
        fine(
          `This link works once and expires in ${WELCOME_LINK_DAYS} days. If it expires, ask our ` +
            'team to send you a new one.',
        ),
        fine('If you were not expecting this email, you can ignore it.'),
      ].join('\n'),
    ),
  };
}

function clientWelcomeAr(
  setPasswordUrl: string,
  firstName: string,
  portalId: number,
): RenderedEmail {
  return {
    subject: 'حسابك في OXShare جاهز — اختر كلمة المرور',
    html: layoutAr(
      'مرحباً بك في OXShare',
      [
        greetingAr(firstName),
        pAr(
          `فتح فريقنا حساباً لك في OXShare. رقم بوابتك هو #${portalId}. ` +
            'ستصلك الرسائل المتعلقة بحسابك على عنوان البريد الإلكتروني هذا.',
        ),
        pAr('لتسجيل الدخول، اختر كلمة المرور الخاصة بك:'),
        buttonAr(setPasswordUrl, 'اختر كلمة المرور'),
        fineAr(
          `يعمل هذا الرابط مرة واحدة وتنتهي صلاحيته خلال ${WELCOME_LINK_DAYS} أيام. إذا انتهت ` +
            'صلاحيته، اطلب من فريقنا إرسال رابط جديد.',
        ),
        fineAr('إذا لم تكن تتوقع هذه الرسالة، يمكنك تجاهلها.'),
      ].join('\n'),
    ),
  };
}
