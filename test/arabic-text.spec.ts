import 'reflect-metadata';
import { describe, expect, it } from 'vitest';
import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import { arabicText } from '../src/common/dto/arabic-text';
import {
  askedProofFields,
  normaliseProofFields,
  readProofDetails,
} from '../src/common/payments/proof-fields';
import { FieldValidationError } from '../src/common/errors/domain-errors';
import {
  CreatePaymentMethodDto,
  ProofFieldInputDto,
  UpdatePaymentMethodDto,
} from '../src/modules/payments/dto/payment-method.dto';
import { UpdateWithdrawalMethodDto } from '../src/modules/payments/dto/withdrawal-method.dto';
import { UpsertAgencyDto, UpsertProductDto } from '../src/modules/products/dto/catalogue.dto';
import { UpdateCurrencyDto } from '../src/modules/currencies/dto/currency.dto';
import { CreateExternalLinkDto } from '../src/modules/external-links/dto/external-link.dto';

/**
 * The Arabic twin of an operator-authored text (0179), as every admin write DTO
 * reads it: optional, trimmed, blank → null, at most the English sibling's length.
 */
function read<T extends object>(cls: new () => T, body: object): { dto: T; errors: string[] } {
  const dto = plainToInstance(cls, body);
  const errors = validateSync(dto, { whitelist: true, forbidNonWhitelisted: true }).map(
    (error) => error.property,
  );
  return { dto, errors };
}

describe('arabicText', () => {
  it('trims, and reads blank or absent as null', () => {
    expect(arabicText('  ويش  ')).toBe('ويش');
    expect(arabicText('   ')).toBeNull();
    expect(arabicText('')).toBeNull();
    expect(arabicText(null)).toBeNull();
    expect(arabicText(undefined)).toBeNull();
  });
});

describe('the write DTOs accept the Arabic twins', () => {
  it('trims a deposit method name and turns blank into null', () => {
    const base = { name: 'Whish', currency: 'USD' };
    expect(read(CreatePaymentMethodDto, { ...base, nameAr: '  ويش ماني ' }).dto.nameAr).toBe(
      'ويش ماني',
    );
    const blank = read(UpdatePaymentMethodDto, { nameAr: '   ' });
    expect(blank.errors).toEqual([]);
    expect(blank.dto.nameAr).toBeNull();
    // Omitted stays undefined — "keep what is stored", not "clear it".
    expect(read(UpdatePaymentMethodDto, { name: 'Whish' }).dto.nameAr).toBeUndefined();
  });

  it('refuses an Arabic name longer than the English limit', () => {
    expect(read(UpdatePaymentMethodDto, { nameAr: 'ا'.repeat(81) }).errors).toEqual(['nameAr']);
    expect(read(UpdateWithdrawalMethodDto, { nameAr: 'ا'.repeat(81) }).errors).toEqual(['nameAr']);
    expect(read(UpdateCurrencyDto, { nameAr: 'ا'.repeat(81) }).errors).toEqual(['nameAr']);
    expect(read(UpdateWithdrawalMethodDto, { nameAr: 'ا'.repeat(80) }).errors).toEqual([]);
  });

  it('accepts proof field labels and hints in Arabic', () => {
    const { dto, errors } = read(ProofFieldInputDto, {
      id: 'f_abc123',
      label: 'Phone',
      type: 'phone',
      required: true,
      enabled: true,
      labelAr: ' الهاتف ',
      hintAr: '',
    });
    expect(errors).toEqual([]);
    expect(dto.labelAr).toBe('الهاتف');
    expect(dto.hintAr).toBeNull();
  });

  it('accepts products, agencies and links', () => {
    expect(
      read(UpsertProductDto, { name: 'Standard', enabled: true, nameAr: 'قياسي' }).errors,
    ).toEqual([]);
    const agency = read(UpsertAgencyDto, {
      name: 'Gold',
      enabled: true,
      nameAr: 'ذهبي',
      descriptionAr: '  ',
    });
    expect(agency.errors).toEqual([]);
    expect(agency.dto.descriptionAr).toBeNull();
    expect(
      read(CreateExternalLinkDto, { title: 'Cal', url: 'https://x.com', titleAr: 'ا'.repeat(81) })
        .errors,
    ).toEqual(['titleAr']);
  });
});

describe('proof fields keep their Arabic (0179)', () => {
  const field = {
    id: 'f_abc123',
    label: 'Code',
    type: 'text',
    required: true,
    enabled: true,
  };

  it('stores a trimmed Arabic label and hint, and drops a blank one', () => {
    const [stored] = normaliseProofFields([{ ...field, labelAr: ' الرمز ', hintAr: '  ' }]);
    expect(stored).toEqual({ ...field, labelAr: 'الرمز' });
  });

  it('refuses an Arabic label past the limit, under its own key', () => {
    expect(() => normaliseProofFields([{ ...field, labelAr: 'ا'.repeat(61) }])).toThrow(
      FieldValidationError,
    );
  });

  it('asks with labelAr/hintAr (null when untranslated) and copies labelAr onto the answer', () => {
    const fields = normaliseProofFields([
      { ...field, labelAr: 'الرمز', hintAr: 'على الإيصال' },
      { ...field, id: 'f_def456', label: 'Other', required: false },
    ]);
    expect(askedProofFields(fields, true)).toMatchObject([
      { labelAr: 'الرمز', hintAr: 'على الإيصال' },
      { labelAr: null, hintAr: null },
    ]);
    expect(readProofDetails(fields, true, { f_abc123: 'AB', f_def456: 'CD' })).toEqual([
      { fieldId: 'f_abc123', label: 'Code', labelAr: 'الرمز', type: 'text', value: 'AB' },
      { fieldId: 'f_def456', label: 'Other', type: 'text', value: 'CD' },
    ]);
  });
});
