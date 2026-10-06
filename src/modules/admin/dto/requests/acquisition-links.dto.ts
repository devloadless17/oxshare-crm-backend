import { ApiPropertyOptional } from '@nestjs/swagger';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
} from 'class-validator';

/** A new sign-up link (0195). */
export class CreateAcquisitionLinkDto {
  @ApiPropertyOptional({ description: 'What the desk calls it ("O_F — Facebook campaign").' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  name!: string;

  @ApiPropertyOptional({
    description: 'Who owns it; the caller when absent. Another administrator needs links.manage.',
  })
  @IsOptional()
  @IsUUID()
  ownerAdminId?: string;

  @ApiPropertyOptional({
    type: [String],
    description:
      "Tags a sign-up arrives with. Absent: the owner's own territory tags. Never a country tag.",
  })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(20)
  @IsUUID('all', { each: true })
  tagIds?: string[];
}

/** Rename, re-tag or hand a link to another administrator. */
export class UpdateAcquisitionLinkDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  name?: string;

  @ApiPropertyOptional({ description: 'Hand the link to another administrator (links.manage).' })
  @IsOptional()
  @IsUUID()
  ownerAdminId?: string;

  @ApiPropertyOptional({ type: [String] })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(20)
  @IsUUID('all', { each: true })
  tagIds?: string[];

  @ApiPropertyOptional({ description: 'Switch the link off (tags nobody) or back on.' })
  @IsOptional()
  @IsBoolean()
  disabled?: boolean;
}
