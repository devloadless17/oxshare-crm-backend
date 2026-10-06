import { ApiProperty } from '@nestjs/swagger';
import { IsString, MaxLength } from 'class-validator';

/** A new word for a sign-up link — `/join/<slug>`. Judged by the service's rule. */
export class RenameSignupLinkDto {
  @ApiProperty({
    example: 'omar-farah',
    description: 'Lowercase letters, digits, - and _; 3–32 characters. The old link stops working.',
  })
  @IsString()
  @MaxLength(64)
  slug!: string;
}
