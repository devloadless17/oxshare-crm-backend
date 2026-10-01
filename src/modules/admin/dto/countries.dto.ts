import { ApiProperty } from '@nestjs/swagger';
import { ArrayMaxSize, ArrayMinSize, IsArray, IsString, Matches } from 'class-validator';
import { NoClientFields } from '../../../common/security/client-field.decorator';

@NoClientFields('platform configuration - a country of the world, no client attribute')
export class CountryDto {
  @ApiProperty({ example: 'LB', description: 'ISO 3166 alpha-2.' })
  code: string;

  @ApiProperty({ example: 'Lebanon' })
  name: string;
}

@NoClientFields('platform configuration - the countries offered, no client attribute')
export class OfferedCountriesDto {
  @ApiProperty({
    type: [String],
    nullable: true,
    example: ['LB', 'AE'],
    description: 'The codes offered, in order; null = every country (nothing chosen yet).',
  })
  offered: string[] | null;

  @ApiProperty({ type: [CountryDto], description: 'Every country that can be offered.' })
  world: CountryDto[];
}

export class SetOfferedCountriesDto {
  @ApiProperty({ type: [String], example: ['LB', 'AE'], description: 'ISO alpha-2 codes.' })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(300)
  @IsString({ each: true })
  @Matches(/^[A-Za-z]{2}$/, { each: true })
  codes: string[];
}
