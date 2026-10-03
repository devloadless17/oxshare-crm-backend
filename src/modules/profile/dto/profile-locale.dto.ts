import { ApiProperty } from '@nestjs/swagger';
import { IsIn } from 'class-validator';
import { LOCALES, type Locale } from '../../../common/i18n/locale';

/** `PUT /profile/locale` — the client's portal language. */
export class UpdateProfileLocaleDto {
  @ApiProperty({
    enum: LOCALES,
    example: 'ar',
    description:
      'The language the client reads the portal in. Stored on the account so mail sent outside ' +
      "the client's own requests (review decisions, payouts, credits) is written in it.",
  })
  @IsIn(LOCALES)
  locale: Locale;
}
