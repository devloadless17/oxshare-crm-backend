import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsHexColor, IsOptional, IsString, MaxLength, MinLength } from 'class-validator';

/**
 * ADM-14 tag inputs.
 *
 * Note what is NOT here: a slug. It is derived from the label
 * (`AdminTagsService.slugify`) and never accepted from a caller. The slug is
 * what appears in the `/clients?tag=` links operators paste into tickets, and
 * asking a person for two names for one thing produces `High Risk`,
 * `high_risk` and `highrisk` in the same table inside a week.
 */
export class CreateClientTagDto {
  @ApiProperty({ example: 'High risk', maxLength: 100 })
  @IsString()
  @MinLength(1)
  @MaxLength(100)
  label: string;

  /**
   * A hex colour for the chip. Validated because it lands in a `style`
   * attribute on the admin screen — an unvalidated string there is a place to
   * put things that are not colours.
   */
  @ApiPropertyOptional({ example: '#b45309' })
  @IsOptional()
  @IsHexColor()
  color?: string;

  @ApiPropertyOptional({ maxLength: 500 })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  description?: string;
}

export class UpdateClientTagDto {
  @ApiPropertyOptional({ maxLength: 100 })
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(100)
  label?: string;

  @ApiPropertyOptional({ example: '#b45309' })
  @IsOptional()
  @IsHexColor()
  color?: string;

  @ApiPropertyOptional({ maxLength: 500 })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  description?: string;
}
