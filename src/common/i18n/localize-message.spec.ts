import { describe, expect, it } from 'vitest';
import { isolateLtrRuns, localizeFields, localizeMessage } from './localize-message';
import { rateLimitMessage } from '../filters/all-exceptions.filter';
import { lockoutMessage } from '../security/lockout-message';
import { checkProfile } from '../profile/client-profile';

/** A left-to-right run as a filled pattern carries it: LRI … PDI. */
const iso = (run: string) => `\u2066${run}\u2069`;

describe('localizeMessage', () => {
  it('translates an exact sentence', () => {
    expect(localizeMessage('Invalid email or password.', 'ar')).toBe(
      'البريد الإلكتروني أو كلمة المرور غير صحيحة.',
    );
  });

  it('fills a pattern, with the captures placed where the Arabic wants them', () => {
    expect(
      localizeMessage(
        'Insufficient commission balance: 10.00 USD available, 25.00 requested.',
        'ar',
      ),
    ).toBe(`رصيد العمولات غير كافٍ: المتاح ${iso('10.00 USD')}، والمطلوب ${iso('25.00')}.`);
    expect(localizeMessage("Unknown platform 'tv'. Expected one of: windows, ios.", 'ar')).toBe(
      `منصة غير معروفة '${iso('tv')}'. القيم المتوقعة: ${iso('windows, ios')}.`,
    );
    // Reordered: the Arabic names the sort field ({2}) before the list ({1}).
    expect(localizeMessage('Cannot sort clients by "age". Allowed: name, email.', 'ar')).toBe(
      `الترتيب حسب "${iso('age')}" غير متاح في ${iso('clients')}. القيم المسموح بها: ${iso('name, email')}.`,
    );
  });

  it('translates a captured label inside a sentence', () => {
    expect(
      localizeMessage(
        'First name may contain only letters, spaces, hyphens and apostrophes — exactly as on your ID.',
        'ar',
      ),
    ).toBe(
      'يجب أن يحتوي الاسم الأول على أحرف ومسافات وشرطات وفواصل عليا فقط — تماماً كما في وثيقة هويتك.',
    );
    expect(localizeMessage('Postal code is required.', 'ar')).toBe('حقل الرمز البريدي مطلوب.');
  });

  it('translates a captured SENTENCE inside a sentence', () => {
    expect(
      localizeMessage(
        'The file content does not match its declared type. Only JPEG, PNG and WebP images are accepted.',
        'ar',
      ),
    ).toBe(
      `محتوى الملف لا يطابق نوعه المُعلن. لا تُقبل إلا صور ${iso('JPEG')} و${iso('PNG')} و${iso('WebP')}.`,
    );
  });

  it('translates a captured list of labels piece by piece', () => {
    expect(localizeMessage('Personal is incomplete: First name, Date of birth.', 'ar')).toBe(
      `خطوة ${iso('Personal')} غير مكتملة: الاسم الأول، تاريخ الميلاد.`,
    );
  });

  it('isolates amounts and codes so bidi cannot reorder them in Arabic (3 Oct 2026)', () => {
    // Found in the Arabic end-to-end test: "$1,000.00" read "1,000.00$" and
    // "50000 USD" read "USD 50000" in the portal's Arabic error box.
    expect(
      localizeMessage(
        'Insufficient balance: the wallet holds $286.69, and this needs $1,000.00.',
        'ar',
      ),
    ).toBe(
      `الرصيد غير كافٍ: تحتوي المحفظة على ${iso('$286.69')}، وتتطلب هذه العملية ${iso('$1,000.00')}.`,
    );
    expect(
      localizeMessage(
        'The maximum single withdrawal is 50000 USD. Please split the request or contact support.',
        'ar',
      ),
    ).toContain(iso('50000 USD'));
    // A sentence written whole by hand is returned exactly as written.
    expect(localizeMessage('Invalid email or password.', 'ar')).not.toContain('\u2066');
  });

  it('isolateLtrRuns keeps a sentence full stop and a sign where they belong', () => {
    expect(isolateLtrRuns('المبلغ -$5.00.')).toBe(`المبلغ ${iso('-$5.00')}.`);
    expect(isolateLtrRuns('رقم MT5 هو 5000001، شكراً')).toBe(
      `رقم ${iso('MT5')} هو ${iso('5000001')}، شكراً`,
    );
    expect(isolateLtrRuns('نص عربي فقط.')).toBe('نص عربي فقط.');
  });

  it('prefers the more specific pattern', () => {
    expect(localizeMessage('each value in tags must be a string', 'ar')).toBe(
      'يجب أن تكون كل قيمة نصاً',
    );
    expect(localizeMessage('tags must be a string', 'ar')).toBe('يجب أن تكون القيمة نصاً');
  });

  it('returns unknown text unchanged', () => {
    expect(localizeMessage('Something nobody catalogued.', 'ar')).toBe(
      'Something nobody catalogued.',
    );
    expect(localizeMessage('', 'ar')).toBe('');
  });

  it('leaves English untouched for the English locale', () => {
    expect(localizeMessage('Invalid email or password.', 'en')).toBe('Invalid email or password.');
    expect(localizeMessage('First name is required.', 'en')).toBe('First name is required.');
  });

  it('covers the sentences built by helpers', () => {
    for (const header of ['43', '60', '900', undefined]) {
      const english = rateLimitMessage(header);
      expect(localizeMessage(english, 'ar')).not.toBe(english);
    }
    for (const ms of [1000, 5000, 60_000, 900_000]) {
      const english = lockoutMessage(ms);
      expect(localizeMessage(english, 'ar')).not.toBe(english);
    }
    const { errors } = checkProfile(
      { firstName: 'J0hn', lastName: '', phone: '+961 7', dateOfBirth: '2020-01-01' },
      { asOf: new Date('2026-10-02T00:00:00Z') },
    );
    for (const sentence of Object.values(errors)) {
      expect(localizeMessage(sentence, 'ar')).toMatch(/^[^A-Za-z]*[\u0600-\u06FF]/);
    }
  });

  it('localizes a field map, keys untouched', () => {
    expect(localizeFields({ 'profile.firstName': 'First name is required.' }, 'ar')).toEqual({
      'profile.firstName': 'حقل الاسم الأول مطلوب.',
    });
  });
});
