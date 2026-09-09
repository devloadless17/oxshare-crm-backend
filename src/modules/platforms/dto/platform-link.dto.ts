import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { NoClientFields } from '../../../common/security/client-field.decorator';
import { IsOptional, IsString, MaxLength } from 'class-validator';
import { PLATFORM_KEYS } from '../platform-links.service';

/**
 * One platform's download link.
 *
 * Both frontends generate their types from this document (R-1.2), so `url`
 * being explicitly nullable is part of the contract rather than an accident:
 * "the operator has not configured this yet" is a state the portal must render
 * differently from a working link, and a non-nullable string would hide it.
 */
@NoClientFields('operator configuration - the platform download links')
export class PlatformLinkDto {
  @ApiProperty({ enum: PLATFORM_KEYS, example: 'desktop' })
  key: string;

  @ApiPropertyOptional({
    type: String,
    nullable: true,
    description: 'Null when the operator has not configured this platform yet.',
    example: 'https://downloads.oxshare.com/OXShare-Terminal.dmg',
  })
  url: string | null;

  @ApiPropertyOptional({
    type: String,
    nullable: true,
    format: 'date-time',
    description: 'When an admin last changed it. Null while unconfigured.',
  })
  updatedAt: string | null;
}

/**
 * Setting one link.
 *
 * `url` is optional and an empty string CLEARS it. Taking a broken download
 * down is something an operator does in a hurry, and making them hunt for a
 * separate delete control is how a dead link stays up.
 *
 * The scheme is checked in the service rather than by a `@IsUrl()` decorator
 * here — see `assertSafeDownloadUrl`. class-validator's `isURL` accepts `http:`
 * and says nothing about `javascript:`, and this value becomes an `href` in
 * every client's browser.
 */
export class SetPlatformLinkDto {
  @ApiPropertyOptional({
    description: 'The https URL, or an empty string to clear it.',
    example: 'https://downloads.oxshare.com/OXShare-Terminal.dmg',
    maxLength: 2048,
  })
  @IsOptional()
  @IsString()
  @MaxLength(2048)
  url?: string;
}
