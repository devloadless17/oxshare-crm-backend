import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsBoolean, IsInt, IsOptional, IsString, Length, MaxLength } from 'class-validator';

/**
 * One link on the client portal's sidebar.
 *
 * `id` is a surrogate, unlike `LeverageDto.ratio` or `CurrencyDto.code`. A link
 * has no natural key: two entries may legitimately share a title, and the URL is
 * the field an operator edits most often — keying on either would turn a typo
 * correction into a delete-and-recreate, and take the row's position with it.
 */
export class ExternalLinkDto {
  @ApiProperty({ format: 'uuid' }) id: string;
  @ApiProperty({ maxLength: 80, example: 'Economic calendar' }) title: string;
  @ApiProperty({
    type: 'string',
    nullable: true,
    maxLength: 300,
    description: 'One line of context under the title. Null is a real answer, not an omission.',
  })
  description: string | null;
  @ApiProperty({ maxLength: 2048, example: 'https://example.com/calendar' }) url: string;
  @ApiProperty({ description: 'A disabled link is off the client menu and still on this screen.' })
  enabled: boolean;
  @ApiProperty({ description: 'The operator’s order, which is the order the sidebar renders.' })
  sortOrder: number;
  @ApiProperty() createdAt: Date;
  @ApiProperty() updatedAt: Date;
}

/**
 * What a CLIENT receives — a strict subset of `ExternalLinkDto`.
 *
 * A separate class rather than the same one with fields the portal ignores,
 * for the reason `ClientAccountDto` exists beside `ClientProfileDto`: the
 * response shape is where "the client is not told this" is enforced, and a
 * shared DTO makes that a convention somebody has to remember.
 *
 * `enabled` is absent because every row here is enabled — the endpoint filters
 * — so the field could only ever say `true`, and a client has no use for the
 * knowledge that other links exist and are switched off. `updatedBy` is absent
 * because it is the id of an administrator, which is not a thing to hand to
 * every customer.
 */
export class ClientExternalLinkDto {
  @ApiProperty({ format: 'uuid' }) id: string;
  @ApiProperty({ maxLength: 80, example: 'Economic calendar' }) title: string;
  @ApiProperty({ type: 'string', nullable: true, maxLength: 300 }) description: string | null;
  @ApiProperty({ maxLength: 2048, example: 'https://example.com/calendar' }) url: string;
  @ApiProperty({ description: 'The operator’s order, which is the order to render.' })
  sortOrder: number;
}

export class CreateExternalLinkDto {
  @ApiProperty({ maxLength: 80, example: 'Economic calendar' })
  @IsString()
  @Length(1, 80)
  title: string;

  @ApiPropertyOptional({ maxLength: 300 })
  @IsOptional()
  @IsString()
  @MaxLength(300)
  description?: string;

  /**
   * Validated as a STRING here and parsed in the service.
   *
   * `@IsUrl()` is deliberately absent. It accepts `javascript:` under its
   * default options and rejects a bare `localhost`, so it would be strict about
   * the thing that does not matter and permissive about the one that does. The
   * service parses with the URL constructor and allows only http(s) — the same
   * call `assertSafeDownloadUrl` makes, for the same reason: the browser's
   * parser is the authority on what a string navigates to.
   */
  @ApiProperty({ maxLength: 2048, example: 'https://example.com/calendar' })
  @IsString()
  @Length(1, 2048)
  url: string;

  @ApiPropertyOptional({ default: true })
  @IsOptional()
  @IsBoolean()
  enabled?: boolean;

  @ApiPropertyOptional({ description: 'Omitted appends to the end of the menu.' })
  @IsOptional()
  @IsInt()
  sortOrder?: number;
}

/**
 * Every field is optional and only what is SENT changes.
 *
 * Unlike `UpdateLeverageDto`, nothing is withheld: the ratio is withheld there
 * because it is the identity of the rung and accounts already carry it. Nothing
 * outside this table references a link, so every field is editable — which is
 * the point of the surrogate id.
 */
export class UpdateExternalLinkDto {
  @ApiPropertyOptional({ maxLength: 80 })
  @IsOptional()
  @IsString()
  @Length(1, 80)
  title?: string;

  /**
   * An empty string CLEARS the description rather than storing `''`.
   *
   * The alternative is a separate control for "remove the subtitle", which is
   * how a stale line of copy stays on screen — the same reasoning
   * `PlatformLinksService.set` records for an empty url.
   */
  @ApiPropertyOptional({ maxLength: 300 })
  @IsOptional()
  @IsString()
  @MaxLength(300)
  description?: string;

  @ApiPropertyOptional({ maxLength: 2048 })
  @IsOptional()
  @IsString()
  @Length(1, 2048)
  url?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  enabled?: boolean;

  @ApiPropertyOptional()
  @IsOptional()
  @IsInt()
  sortOrder?: number;
}
