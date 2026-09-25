import { ApiProperty } from '@nestjs/swagger';

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
}
