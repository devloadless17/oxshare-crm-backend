import { describe, expect, it } from 'vitest';
import type { ArgumentsHost } from '@nestjs/common';
import { BadRequestException } from '@nestjs/common';
import { AllExceptionsFilter } from './all-exceptions.filter';
import {
  ExternalServiceError,
  FieldValidationError,
  MoneyRuleError,
  ValidationError,
} from '../errors/domain-errors';
import { registerLabelTwins } from '../i18n/localize-message';
import { requestContext } from '../logging/request-context';

/**
 * The error envelope in the portal's language (2 Oct 2026).
 *
 * The portal sends `X-OxShare-Locale: ar`; every sentence — `message` and each
 * `fields` entry — comes back in Arabic, while `code` and the field KEYS stay
 * exactly as they were, because they are what a screen branches on. The admin
 * console never sends the header and must keep reading English.
 */

interface Sent {
  status?: number;
  body?: Record<string, unknown>;
}

function hostFor(headers: Record<string, string>, url: string, sent: Sent): ArgumentsHost {
  const response = {
    getHeader: () => undefined,
    status(code: number) {
      sent.status = code;
      return this;
    },
    json(body: Record<string, unknown>) {
      sent.body = body;
      return this;
    },
  };
  const request = { id: 'req-1', method: 'POST', url, headers, route: {} };
  return {
    switchToHttp: () => ({ getRequest: () => request, getResponse: () => response }),
  } as unknown as ArgumentsHost;
}

function answer(error: unknown, headers: Record<string, string>, url = '/v1/auth/register'): Sent {
  const sent: Sent = {};
  new AllExceptionsFilter().catch(error, hostFor(headers, url, sent));
  return sent;
}

const fieldError = () =>
  new FieldValidationError('First name is required.', {
    firstName: 'First name is required.',
    phone: 'This phone number is too short. Enter all the digits after +961.',
  });

describe('AllExceptionsFilter speaks the request language', () => {
  it('answers an Arabic request in Arabic — message and every field', () => {
    const { status, body } = answer(fieldError(), { 'x-oxshare-locale': 'ar' });
    expect(status).toBe(400);
    expect(body?.code).toBe('VALIDATION_FAILED');
    expect(body?.message).toBe('حقل الاسم الأول مطلوب.');
    expect(body?.fields).toEqual({
      firstName: 'حقل الاسم الأول مطلوب.',
      phone: 'رقم الهاتف هذا قصير جداً. أدخل جميع الأرقام بعد ‎\u2066+961\u2069.',
    });
    expect(body?.requestId).toBe('req-1');
  });

  it('translates the validator’s array of sentences, keeping the field keys', () => {
    const pipe = new BadRequestException({
      code: 'VALIDATION_FAILED',
      message: ['amount must be a number string', 'property foo should not exist'],
      fields: { amount: 'amount must be a number string' },
    });
    const { body } = answer(pipe, { 'x-oxshare-locale': 'ar' });
    expect(body?.code).toBe('VALIDATION_FAILED');
    expect(body?.message).toEqual(['يجب أن تكون القيمة رقماً', 'هذا الحقل غير مسموح به']);
    expect(body?.fields).toEqual({ amount: 'يجب أن تكون القيمة رقماً' });
  });

  it('prefers the locale the request context carries', () => {
    const { body } = requestContext.run({ requestId: 'r', locale: 'ar' }, () =>
      answer(new ValidationError('Invalid email or password.'), {}),
    );
    expect(body?.message).toBe('البريد الإلكتروني أو كلمة المرور غير صحيحة.');
  });

  it('leaves a request without the header in English', () => {
    const { body } = answer(fieldError(), {});
    expect(body?.message).toBe('First name is required.');
    expect(body?.fields).toEqual({
      firstName: 'First name is required.',
      phone: 'This phone number is too short. Enter all the digits after +961.',
    });
  });

  it('keeps an admin request English — the console never sends the header', () => {
    const { body } = answer(
      new ValidationError('Only a pending withdrawal can be approved; this one is approved.'),
      { 'accept-language': 'ar' },
      '/v1/admin/withdrawals/1/approve',
    );
    expect(body?.message).toBe('Only a pending withdrawal can be approved; this one is approved.');
  });

  it('answers an unexpected error with the generic sentence in Arabic', () => {
    const { status, body } = answer(new Error('boom'), { 'x-oxshare-locale': 'ar' });
    expect(status).toBe(500);
    expect(body?.code).toBe('INTERNAL_ERROR');
    expect(body?.message).toBe('حدث خطأ غير متوقع. يُرجى ذكر رقم الطلب عند الإبلاغ عنه.');
  });

  /*
   * Text from OUTSIDE the platform (3 Oct 2026): a payment provider, the MT5
   * bridge, the mail server. It is English and cannot be catalogued, so an
   * Arabic reader gets a generic Arabic headline for the status and the English
   * moves to `detail` — nothing lost, nothing English as the headline.
   */
  it('gives an Arabic reader a generic headline for provider English, keeping it in detail', () => {
    const { status, body } = answer(
      new ExternalServiceError('Rival: upstream gateway timeout (code 504-GW)'),
      { 'x-oxshare-locale': 'ar' },
    );
    expect(status).toBe(502);
    expect(body?.code).toBe('EXTERNAL_SERVICE_ERROR');
    expect(body?.message).toBe('الخدمة غير متاحة مؤقتاً. يُرجى المحاولة لاحقاً.');
    expect(body?.detail).toBe('Rival: upstream gateway timeout (code 504-GW)');
  });

  it('chooses the generic headline by status — 400, 422', () => {
    const bad = answer(new ValidationError('3pay: destination wallet blacklisted'), {
      'x-oxshare-locale': 'ar',
    });
    expect(bad.body?.message).toBe('تعذّر قبول الطلب.');
    expect(bad.body?.detail).toBe('3pay: destination wallet blacklisted');
    const rule = answer(new MoneyRuleError('Whish refused: limit reached'), {
      'x-oxshare-locale': 'ar',
    });
    expect(rule.status).toBe(422);
    expect(rule.body?.message).toBe('تعذّر تنفيذ هذه العملية.');
  });

  it('replaces an untranslatable FIELD message too, naming the field in detail', () => {
    const { body } = answer(
      new FieldValidationError('First name is required.', { iban: 'Provider says: IBAN rejected' }),
      { 'x-oxshare-locale': 'ar' },
    );
    expect(body?.message).toBe('حقل الاسم الأول مطلوب.');
    expect(body?.fields).toEqual({ iban: 'هذه القيمة غير مقبولة.' });
    expect(body?.detail).toBe('iban: Provider says: IBAN rejected');
  });

  it('adds no detail when everything translated, and none at all in English', () => {
    expect(answer(fieldError(), { 'x-oxshare-locale': 'ar' }).body).not.toHaveProperty('detail');
    const english = answer(new ExternalServiceError('Rival: upstream gateway timeout'), {});
    expect(english.body?.message).toBe('Rival: upstream gateway timeout');
    expect(english.body).not.toHaveProperty('detail');
  });

  it("names a broker's own question in Arabic when its label was registered", () => {
    const { body } = requestContext.run({ requestId: 'r', locale: 'ar' }, () => {
      registerLabelTwins([['Favourite colour', 'اللون المفضل']]);
      return answer(
        new FieldValidationError('Favourite colour is required.', {
          customField_1: 'Favourite colour is required.',
        }),
        {},
      );
    });
    expect(body?.message).toBe('حقل اللون المفضل مطلوب.');
    expect(body?.fields).toEqual({ customField_1: 'حقل اللون المفضل مطلوب.' });
    expect(body).not.toHaveProperty('detail');
  });

  it('keeps an Arabic sentence whose label had no Arabic, rather than calling it English', () => {
    const { body } = answer(new ValidationError('Favourite colour is required.'), {
      'x-oxshare-locale': 'ar',
    });
    // The pattern translated; the label stays as the broker wrote it.
    expect(body?.message).toBe('حقل \u2066Favourite colour\u2069 مطلوب.');
    expect(body).not.toHaveProperty('detail');
  });
});
