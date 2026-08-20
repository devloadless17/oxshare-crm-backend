import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsEmail, IsIn, IsOptional, IsString, Length, Matches, MaxLength } from 'class-validator';
import { Transform } from 'class-transformer';

// Request DTO for the client list actions.
// See the note in ./auth.dto.ts for why this moved out of the controller.

const CLIENT_STATUSES = ['active', 'suspended'] as const;

export class ClientStatusDto {
  @ApiProperty({
    enum: CLIENT_STATUSES,
    description: 'Suspending blocks sign-in but preserves the client and their ledger history.',
  })
  @IsIn(CLIENT_STATUSES)
  status: (typeof CLIENT_STATUSES)[number];
}

/**
 * What an administrator may correct on a client's profile.
 *
 * ## Email is NOT here, and its absence is the design
 *
 * Changing the address an account signs in with is an account-takeover
 * primitive — point it at your own inbox, run a password reset, take the
 * balance — so it lives on its own endpoint behind its own permission
 * (`clients.email`). Folding it in here would mean every operator who can fix a
 * misspelled surname can also empty an account, and nothing in the grant would
 * say so. See `ChangeClientEmailDto`.
 *
 * ## Every field OPTIONAL, and at least one required
 *
 * A PATCH names what changes. Requiring the whole profile would make a caller
 * echo values it did not intend to touch, which is how one screen's stale copy
 * of a phone number silently overwrites another's fresh one.
 */
export class UpdateClientProfileDto {
  @ApiPropertyOptional({ example: 'Layla' })
  @IsOptional()
  @IsString()
  @Length(1, 100)
  firstName?: string;

  @ApiPropertyOptional({ example: 'Haddad' })
  @IsOptional()
  @IsString()
  @Length(1, 100)
  lastName?: string;

  /**
   * NULLABLE on purpose: an empty string clears it.
   *
   * "This client never gave us a phone number" and "this client's number is the
   * empty string" are the same fact to a reader and different rows in the
   * database. Normalising blank to NULL keeps the column honest.
   */
  @ApiPropertyOptional({
    example: '+9613111222',
    nullable: true,
    description: 'Send an empty string to clear it.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(32)
  @Matches(/^$|^[+]?[\d\s()-]{6,32}$/, {
    message: 'phone must be 6 to 32 digits, optionally with +, spaces, dashes or parentheses',
  })
  phone?: string;

  @ApiPropertyOptional({ example: 'Lebanon', nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  country?: string;
}

/**
 * The sign-in address, on its own endpoint behind its own permission.
 *
 * Lower-cased and trimmed before it is stored or compared, matching
 * registration and login: `users.email` is uniquely indexed as written, so
 * "Layla@x.com" and "layla@x.com" would otherwise be two accounts that one
 * person believes are one — and a login that works on one screen and not
 * another.
 */
export class ChangeClientEmailDto {
  @ApiProperty({ example: 'layla.haddad@example.com' })
  @Transform(({ value }) => (typeof value === 'string' ? value.trim().toLowerCase() : value))
  @IsEmail({}, { message: 'A valid email address is required.' })
  @MaxLength(255)
  email: string;
}
