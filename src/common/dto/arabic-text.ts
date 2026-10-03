import { applyDecorators } from '@nestjs/common';
import { ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsOptional, IsString, MaxLength, ValidateIf } from 'class-validator';

/**
 * The Arabic twin of an operator-authored text (0179).
 *
 * The English stays the canonical value; the Arabic is optional, and a blank one
 * means "not translated" — the portal falls back to the English rather than
 * rendering an empty label. So a blank is stored as NULL, never as ''.
 */
export function arabicText(value: string | null | undefined): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}

/**
 * A write DTO's optional Arabic field: trimmed, blank → null, at most `maxLength`
 * (the English sibling's limit). On an update, omitted keeps the stored Arabic
 * and null or blank clears it.
 */
export function OptionalArabicText(maxLength: number, example?: string) {
  return applyDecorators(
    ApiPropertyOptional({
      type: 'string',
      nullable: true,
      maxLength,
      ...(example ? { example } : {}),
      description:
        'Arabic for the portal’s Arabic readers. Optional; blank or null = not translated ' +
        '(the portal shows the English).',
    }),
    Transform(({ value }: { value: unknown }) =>
      typeof value === 'string' ? arabicText(value) : value,
    ),
    IsOptional(),
    ValidateIf((_o, value) => value !== null),
    IsString(),
    MaxLength(maxLength),
  );
}
