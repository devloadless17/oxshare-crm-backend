import type { Locale } from '../../../common/i18n/locale';
import {
  button,
  buttonAr,
  esc,
  fine,
  fineAr,
  layout,
  layoutAr,
  p,
  pAr,
  panel,
  panelAr,
  type RenderedEmail,
} from './layout';

/**
 * "Confirm your email" — sent on registration, on resend, and when an
 * unconfirmed owner signs in.
 *
 * ## The code first, the link second
 *
 * The client asked for sign-up to end on a screen asking for a code from this
 * email, and to be signed straight in by the right one (25 Sep 2026). So the
 * code leads, large and spaced for reading off a phone, and the link follows as
 * the fallback for opening the email on another device.
 *
 * The code is in the SUBJECT too, on purpose: phones and mail apps offer a code
 * from a subject line for one-tap entry, and a notification preview then shows
 * it without opening anything. It is single-use and dies in 15 minutes, which is
 * what makes that acceptable.
 *
 * `code` is absent only for an address an ADMIN changed — nobody is in front of
 * a code screen then, so that mail carries the link alone.
 *
 * The URL carries a bearer token. It is composed by the caller from
 * `PORTAL_URL` and never logged (R-6.3), which is why this template receives a
 * finished URL rather than the token itself: a template that built the link
 * would be a second place that knows the token, and one of them would log it.
 */
export function verifyEmail(
  verificationUrl: string,
  code?: string,
  locale: Locale = 'en',
): RenderedEmail {
  if (locale === 'ar') return verifyEmailAr(verificationUrl, code);
  if (!code) {
    return {
      subject: 'Verify Your Email — OxShare Portal',
      html: layout(
        'Welcome to OxShare Portal',
        [
          p('Please verify your email address to complete your registration.'),
          button(verificationUrl, 'Verify Email Address'),
          fine('If you did not request this email, please ignore it.'),
        ].join('\n'),
      ),
    };
  }

  return {
    subject: `${code} is your OxShare verification code`,
    html: layout(
      'Confirm your email',
      [
        // True whichever screen asked: sign-up, or a sign-in to an account
        // whose address was never confirmed — both mail this same code.
        p(
          'Thank you for registering with OxShare. Enter this code on the confirmation ' +
            'screen to confirm your email and sign in:',
        ),
        panel(
          `<div style="font-size: 32px; font-weight: 700; letter-spacing: 10px; text-align: center; font-family: 'Courier New', Courier, monospace;">${esc(code)}</div>`,
        ),
        fine(
          'The code expires in 15 minutes and works once. Never share it — OxShare ' +
            'will never ask you for it.',
        ),
        p('Opening this on another device? Confirm with a link instead:'),
        button(verificationUrl, 'Confirm with a link'),
        fine(
          'If you did not create an OxShare account, you can ignore this email — ' +
            'nothing happens unless the code or the link is used.',
        ),
      ].join('\n'),
    ),
  };
}

/**
 * The Arabic twin. Same order — the code first, large and LEFT-TO-RIGHT so the
 * digits read as typed, then the link — and the code still leads the subject
 * so a phone can offer it from the notification.
 */
function verifyEmailAr(verificationUrl: string, code?: string): RenderedEmail {
  if (!code) {
    return {
      subject: 'تأكيد بريدك الإلكتروني — OXShare',
      html: layoutAr(
        'مرحباً بك في بوابة OXShare',
        [
          pAr('يُرجى تأكيد عنوان بريدك الإلكتروني لإكمال تسجيلك.'),
          buttonAr(verificationUrl, 'تأكيد البريد الإلكتروني'),
          fineAr('إذا لم تطلب هذه الرسالة، يُرجى تجاهلها.'),
        ].join('\n'),
      ),
    };
  }

  return {
    subject: `${code} هو رمز التحقق الخاص بك في OXShare`,
    html: layoutAr(
      'تأكيد بريدك الإلكتروني',
      [
        pAr(
          'شكراً لتسجيلك في OXShare. أدخل هذا الرمز في شاشة التأكيد لتأكيد بريدك ' +
            'الإلكتروني وتسجيل الدخول:',
        ),
        panelAr(
          `<div dir="ltr" style="font-size: 32px; font-weight: 700; letter-spacing: 10px; text-align: center; direction: ltr; unicode-bidi: isolate; font-family: 'Courier New', Courier, monospace;">${esc(code)}</div>`,
        ),
        fineAr(
          'تنتهي صلاحية الرمز خلال 15 دقيقة، ولا يمكن استخدامه إلا مرة واحدة. لا تشاركه مع أي ' +
            'شخص — لن تطلبه منك OXShare أبداً.',
        ),
        pAr('هل تفتح هذه الرسالة على جهاز آخر؟ يمكنك التأكيد عبر رابط بدلاً من ذلك:'),
        buttonAr(verificationUrl, 'التأكيد عبر رابط'),
        fineAr(
          'إذا لم تُنشئ حساباً في OXShare، يمكنك تجاهل هذه الرسالة — لن يحدث شيء ما لم ' +
            'يُستخدم الرمز أو الرابط.',
        ),
      ].join('\n'),
    ),
  };
}
