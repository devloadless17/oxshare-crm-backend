import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { composeReasonArabic, rebateNameArabic, systemSentenceArabic } from './reason-arabic';

/**
 * The Arabic of a stored reason, decided once when it is written (3 Oct 2026) —
 * the same composition the English has: a configured label, then the
 * reviewer's note, joined by " — ".
 */
describe('composeReasonArabic', () => {
  it('is the reviewer’s own Arabic for a free-text reason', () => {
    expect(composeReasonArabic({ note: 'Too dark.', noteAr: '  داكنة جداً.  ' })).toBe(
      'داكنة جداً.',
    );
  });

  it('is null when nothing was translated — the reader falls back', () => {
    expect(composeReasonArabic({ note: 'Too dark.' })).toBeNull();
    expect(composeReasonArabic({ note: 'Too dark.', noteAr: '   ' })).toBeNull();
    expect(composeReasonArabic({ label: 'Expired', labelAr: null, note: 'x' })).toBeNull();
  });

  it('copies a configured label’s Arabic, with the note in Arabic or as typed', () => {
    expect(composeReasonArabic({ label: 'Expired', labelAr: 'منتهية' })).toBe('منتهية');
    expect(composeReasonArabic({ label: 'Expired', labelAr: 'منتهية', note: 'Since May.' })).toBe(
      'منتهية — Since May.',
    );
    expect(
      composeReasonArabic({
        label: 'Expired',
        labelAr: 'منتهية',
        note: 'Since May.',
        noteAr: 'منذ مايو.',
      }),
    ).toBe('منتهية — منذ مايو.');
    // A label with no Arabic keeps its English beside the reviewer's Arabic.
    expect(composeReasonArabic({ label: 'Expired', note: 'Since May.', noteAr: 'منذ مايو.' })).toBe(
      'Expired — منذ مايو.',
    );
  });
});

describe('systemSentenceArabic', () => {
  it('is the catalogue’s Arabic for a sentence the system writes, else null', () => {
    expect(systemSentenceArabic('The payment provider could not complete this withdrawal.')).toBe(
      'تعذّر على مزوّد الدفع إتمام عملية السحب هذه.',
    );
    expect(systemSentenceArabic('The trading platform refused this transfer.')).toBe(
      'رفضت منصة التداول هذا التحويل.',
    );
    expect(systemSentenceArabic('Something an operator typed.')).toBeNull();
    expect(systemSentenceArabic(null)).toBeNull();
  });
});

describe('rebateNameArabic', () => {
  it('names a rebate, and a batched one with its count in correct Arabic', () => {
    expect(rebateNameArabic('rebate', 'Rebate')).toBe('العمولة المستردة');
    expect(rebateNameArabic('rebate', 'Rebate · 2 trades')).toBe('العمولة المستردة · صفقتان');
    expect(rebateNameArabic('rebate', 'Rebate · 7 trades')).toBe('العمولة المستردة · 7 صفقات');
    expect(rebateNameArabic('rebate', 'Rebate · 40 trades')).toBe('العمولة المستردة · 40 صفقة');
  });

  it('is null for anything that is not a rebate', () => {
    expect(rebateNameArabic('payment', 'Rebate')).toBeNull();
    expect(rebateNameArabic('rebate', null)).toBeNull();
  });
});

describe('GET /trading/accounts/self-service is in the contract', () => {
  it('declares its response, productAr included', () => {
    const doc = JSON.parse(readFileSync(join(__dirname, '../../../openapi.json'), 'utf8')) as {
      paths: Record<string, Record<string, { responses: Record<string, unknown> }>>;
      components: { schemas: Record<string, { properties: Record<string, unknown> }> };
    };
    const ok = JSON.stringify(doc.paths['/v1/trading/accounts/self-service'].get.responses['200']);
    expect(ok).toContain('#/components/schemas/SelfServiceOfferDto');
    expect(Object.keys(doc.components.schemas.SelfServiceAccountTypeDto.properties)).toEqual([
      'group',
      'currency',
      'product',
      'productAr',
      'productId',
    ]);
  });
});
