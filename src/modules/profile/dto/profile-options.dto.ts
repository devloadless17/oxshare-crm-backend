import { ApiProperty } from '@nestjs/swagger';
import { PROFILE_FIELD_KEYS, type ProfileKey } from '../../../common/profile/client-profile';

/** Which profile fields each moment requires — the platform's, never a form's copy. */
export class ProfileRequiredDto {
  @ApiProperty({
    enum: PROFILE_FIELD_KEYS,
    isArray: true,
    description: 'Required to register: who the person is and how to reach them.',
    example: ['firstName', 'lastName', 'dateOfBirth', 'nationality', 'phone', 'country'],
  })
  registration!: ProfileKey[];

  @ApiProperty({
    enum: PROFILE_FIELD_KEYS,
    isArray: true,
    description: 'Required to submit a verification: everything but the postal code.',
  })
  verification!: ProfileKey[];
}

/** The choices a client profile's drop-downs accept — and the only ones. */
export class ProfileOptionsDto {
  @ApiProperty({
    type: [String],
    description: 'Countries of residence, sorted by name. Exactly the values the profile accepts.',
    example: ['Lebanon', 'United Arab Emirates'],
  })
  countries!: string[];

  @ApiProperty({
    type: [String],
    description: 'Nationalities, as demonyms. Exactly the values the profile accepts.',
    example: ['Emirati', 'Lebanese'],
  })
  nationalities!: string[];

  @ApiProperty({
    type: ProfileRequiredDto,
    description:
      'Which fields are required, and when. Served so no form keeps its own copy of the rule ' +
      '(the owner\u2019s ruling, 26 Sep 2026).',
  })
  required!: ProfileRequiredDto;
}
