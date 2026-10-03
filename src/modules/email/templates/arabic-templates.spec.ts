import { describe, expect, it } from 'vitest';
import {
  commissionSummaryReason,
  depositOutcome,
  emailChangedNotice,
  kycDecision,
  kycDetailsCorrected,
  kycReverification,
  partnerDecision,
  passwordReset,
  tradingAccountOpened,
  tradingAccountPasswordReset,
  verifyEmail,
  walletCredit,
  withdrawalDecision,
  type RenderedEmail,
} from './index';

/**
 * Every client email in Arabic: an RTL document, an Arabic subject, the brand
 * kept Latin, and every value that must read left to right ISOLATED so the
 * bidi algorithm cannot reorder it. And English — the default — unchanged.
 */

const P = 'https://portal.test';
const ARABIC = /[؀-ۿ]/;
const isolated = (html: string, value: string) =>
  html.includes(`<span dir="ltr" style="unicode-bidi: isolate;">${value}</span>`);

/** The checks every Arabic mail must pass. */
function expectArabic(mail: RenderedEmail): void {
  expect(mail.subject).toMatch(ARABIC);
  expect(mail.html).toContain('<html lang="ar" dir="rtl">');
  expect(mail.html).toContain('<body dir="rtl"');
  expect(mail.html).toContain('<td dir="rtl" align="right"');
  expect(mail.html).toContain('direction: rtl; text-align: right;');
  expect(mail.html).toContain("'Segoe UI', Tahoma, Arial, sans-serif");
  expect(mail.html).toContain('OXShare');
  // The Arabic footer, never the English one.
  expect(mail.html).toContain('هذه رسالة آلية من OXShare');
  expect(mail.html).not.toContain('This is an automated message');
  // No English sentence leaked through: no run of three Latin words.
  const text = mail.html.replace(/<[^>]+>/g, ' ').replace(/https?:\/\/\S+/g, ' ');
  expect(text).not.toMatch(/\b[A-Za-z]{3,} [A-Za-z]{3,} [A-Za-z]{3,}\b/);
}

/** Each template, rendered in both languages from the same arguments. */
const CASES: Record<string, (locale?: 'en' | 'ar') => RenderedEmail> = {
  'verification code': (l) => verifyEmail(`${P}/auth/verify-email?token=t`, '482913', l),
  'verification link': (l) => verifyEmail(`${P}/auth/verify-email?token=t`, undefined, l),
  'password reset': (l) => passwordReset(`${P}/auth/reset-password?token=t`, l),
  'email changed': (l) => emailChangedNotice('new@client.test', 'support@oxshare.test', l),
  'kyc approved': (l) => kycDecision('Jane', 'approved', P, undefined, undefined, l),
  'kyc rejected': (l) => kycDecision('Jane', 'rejected', P, 'Mismatch', ['Passport'], l),
  'kyc corrected': (l) => kycDetailsCorrected('Jane', ['First Name'], P, l),
  'kyc reverification': (l) => kycReverification('Jane', 'Mismatch', ['Passport'], P, l),
  'partner approved': (l) => partnerDecision('Jane', 'approved', P, { referralCode: 'AB12CD' }, l),
  'partner rejected': (l) => partnerDecision('Jane', 'rejected', P, { reason: 'Mismatch' }, l),
  'wallet credit': (l) => walletCredit('Jane', '500.00000000', 'USD', 'Mismatch', P, l),
  'account opened': (l) =>
    tradingAccountOpened(
      'Jane',
      '700123',
      'live',
      'USD',
      500,
      'Ma$ter1',
      'Inv#2',
      P,
      undefined,
      '0',
      l,
    ),
  'account password reset': (l) =>
    tradingAccountPasswordReset('Jane', '700123', 'demo', 'Ma$ter1', 'Inv#2', P, 's@ox.test', l),
  'deposit succeeded': (l) =>
    depositOutcome('Jane', 'succeeded', '75.00000000', 'USD', P, undefined, l),
  'deposit failed': (l) => depositOutcome('Jane', 'failed', '75.00000000', 'USD', P, undefined, l),
  'deposit rejected': (l) =>
    depositOutcome('Jane', 'rejected', '75.00000000', 'USD', P, 'Mismatch', l),
  'withdrawal approved': (l) =>
    withdrawalDecision('Jane', 'approved', '11.00000000', 'USD', P, undefined, l),
  'withdrawal paid': (l) =>
    withdrawalDecision('Jane', 'paid', '11.00000000', 'USD', P, undefined, l),
  'withdrawal rejected': (l) =>
    withdrawalDecision('Jane', 'rejected', '11.00000000', 'USD', P, 'Mismatch', l),
};

describe('every client email has an Arabic version', () => {
  for (const [name, render] of Object.entries(CASES)) {
    it(`${name}: RTL document, Arabic subject and body`, () => {
      expectArabic(render('ar'));
    });

    it(`${name}: English is the default, and unchanged by the Arabic work`, () => {
      const en = render('en');
      expect(render()).toEqual(en);
      expect(en.html).not.toContain('dir="rtl"');
      expect(en.html).not.toMatch(ARABIC);
      expect(en.html).toContain('This is an automated message from OxShare.');
      expect(en.subject).not.toMatch(ARABIC);
    });
  }
});

describe('the verification code, in Arabic', () => {
  const mail = verifyEmail(`${P}/auth/verify-email?token=t`, '482913', 'ar');

  it('leads the subject with the code, for one-tap entry from a notification', () => {
    expect(mail.subject.startsWith('482913 ')).toBe(true);
    expect(mail.subject).toContain('رمز التحقق');
  });

  it('prints the code left-to-right, isolated, large', () => {
    expect(mail.html).toMatch(
      /<div dir="ltr" style="[^"]*unicode-bidi: isolate;[^"]*">482913<\/div>/,
    );
    expect(mail.html).toContain('font-size: 32px');
  });

  it('states the 15-minute, single-use limit and the never-share warning', () => {
    expect(mail.html).toContain('15 دقيقة');
    expect(mail.html).toContain('مرة واحدة');
    expect(mail.html).toContain('لا تشاركه');
  });

  it('keeps the fallback link, untouched', () => {
    expect(mail.html).toContain(`href="${P}/auth/verify-email?token=t"`);
    expect(mail.html).toContain('التأكيد عبر رابط');
  });
});

describe('the password reset, in Arabic', () => {
  const mail = passwordReset(`${P}/auth/reset-password?token=t`, 'ar');

  it('carries the link and an Arabic button', () => {
    expect(mail.html).toContain(`href="${P}/auth/reset-password?token=t"`);
    expect(mail.html).toContain('إعادة تعيين كلمة المرور');
  });

  it("states the token's REAL lifetime (30 minutes) and that ignoring it is safe", () => {
    expect(mail.html).toContain('30 دقيقة');
    expect(mail.html).toContain('يمكنك تجاهل هذه الرسالة');
  });
});

describe('values that must read left to right are isolated', () => {
  it('amounts', () => {
    expect(isolated(walletCredit('J', '500.00000000', 'USD', 'r', P, 'ar').html, '$500.00')).toBe(
      true,
    );
    expect(
      isolated(
        depositOutcome('J', 'succeeded', '75.00000000', 'USD', P, undefined, 'ar').html,
        '$75.00',
      ),
    ).toBe(true);
    const declined = withdrawalDecision('J', 'rejected', '11.00000000', 'USD', P, 'r', 'ar').html;
    expect(
      declined.split('<span dir="ltr" style="unicode-bidi: isolate;">$11.00</span>').length,
    ).toBe(3);
  });

  it('email addresses, logins, referral codes and passwords', () => {
    const changed = emailChangedNotice('new@client.test', 'support@oxshare.test', 'ar').html;
    expect(isolated(changed, 'new@client.test')).toBe(true);
    expect(isolated(changed, 'support@oxshare.test')).toBe(true);

    const opened = tradingAccountOpened(
      'J',
      '700123',
      'live',
      'USD',
      500,
      'Ma$ter1',
      'Inv#2',
      P,
      undefined,
      undefined,
      'ar',
    ).html;
    expect(isolated(opened, '700123')).toBe(true);
    expect(isolated(opened, '1:500')).toBe(true);
    expect(opened).toContain('<code dir="ltr" style="unicode-bidi: isolate;">Ma$ter1</code>');
    expect(opened).toContain('<code dir="ltr" style="unicode-bidi: isolate;">Inv#2</code>');

    const partner = partnerDecision('J', 'approved', P, { referralCode: 'AB12CD' }, 'ar').html;
    expect(isolated(partner, 'AB12CD')).toBe(true);
  });

  it('still escapes what it isolates', () => {
    const changed = emailChangedNotice('<b>x</b>@client.test', 's@x.test', 'ar').html;
    expect(changed).not.toContain('<b>x</b>');
    expect(changed).toContain('&lt;b&gt;x&lt;/b&gt;@client.test');
  });
});

describe('the Arabic copy keeps the rules the English copy is pinned to', () => {
  it('a rejected offline deposit promises no refund and does not say nothing was taken', () => {
    const html = depositOutcome(
      'J',
      'rejected',
      '60.00000000',
      'USD',
      P,
      'الإيصال غير واضح',
      'ar',
    ).html;
    expect(html).toContain('الإيصال غير واضح');
    expect(html).not.toContain('لم تقتطع');
    expect(html).not.toMatch(/استرداد|نُعيد إليك/);
    expect(html).toContain('تواصل مع فريق الدعم');
  });

  it('a rejected deposit without a reason prints no reason line', () => {
    expect(depositOutcome('J', 'rejected', '60', 'USD', P, undefined, 'ar').html).not.toContain(
      'السبب',
    );
  });

  it('greets a nameless client politely rather than with a blank', () => {
    expect(kycDecision('', 'approved', P, undefined, undefined, 'ar').html).toContain(
      'مرحباً عميلنا العزيز،',
    );
  });

  it('lists fields to correct with the Arabic comma', () => {
    const html = kycDecision('J', 'rejected', P, 'r', ['Passport', 'Last Name'], 'ar').html;
    expect(html).toContain('Passport، Last Name');
  });
});

describe('the commission summary reason', () => {
  it('is byte-identical in English', () => {
    expect(commissionSummaryReason('rebate', 3)).toBe('Trading rebate on 3 closed trade(s)');
    expect(commissionSummaryReason('commission', 1, 'en')).toBe(
      'Partner commission on 1 closed trade(s)',
    );
  });

  it('uses the Arabic plural forms', () => {
    expect(commissionSummaryReason('commission', 1, 'ar')).toBe('عمولة الشريك عن صفقة مغلقة واحدة');
    expect(commissionSummaryReason('commission', 2, 'ar')).toBe('عمولة الشريك عن صفقتين مغلقتين');
    expect(commissionSummaryReason('rebate', 5, 'ar')).toBe('عمولة مستردة عن 5 صفقات مغلقة');
    expect(commissionSummaryReason('rebate', 11, 'ar')).toBe('عمولة مستردة عن 11 صفقة مغلقة');
    expect(commissionSummaryReason('rebate', 100, 'ar')).toBe('عمولة مستردة عن 100 صفقة مغلقة');
  });
});
