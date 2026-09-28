import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsEmail,
  IsIn,
  IsNotEmpty,
  IsOptional,
  IsString,
  Length,
  MaxLength,
} from 'class-validator';
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

  /*
   * The rest of the profile. Every value here is checked and normalised by
   * `common/profile/client-profile.ts` in `ClientProfileService` — the same
   * rules registration and the KYC personal step apply — so the decorators only
   * bound the SHAPE. An empty string clears an optional field; a name can never
   * be cleared.
   */
  @ApiPropertyOptional({
    example: '+9613111222',
    description: 'International format with the country code; stored as E.164. Empty clears it.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(32)
  phone?: string;

  @ApiPropertyOptional({
    example: 'Lebanon',
    description: 'Country of residence, from the KYC country list. Empty clears it.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  country?: string;

  @ApiPropertyOptional({ example: '1990-04-12', description: 'YYYY-MM-DD, 18 or older.' })
  @IsOptional()
  @IsString()
  @MaxLength(10)
  dateOfBirth?: string;

  @ApiPropertyOptional({ example: 'Lebanese', description: 'From the KYC nationality list.' })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  nationality?: string;

  @ApiPropertyOptional({ example: 'Hamra Street, Building 12', maxLength: 200 })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  address?: string;

  @ApiPropertyOptional({ example: 'Beirut', maxLength: 100 })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  city?: string;

  @ApiPropertyOptional({ example: 'Mount Lebanon', maxLength: 100 })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  stateProvince?: string;

  @ApiPropertyOptional({ example: '1103 2080', maxLength: 12 })
  @IsOptional()
  @IsString()
  @MaxLength(12)
  postalCode?: string;

  /*
   * Why a VERIFIED detail changes — required exactly when one does (the
   * profile's `correctableFields`), and ignored otherwise. It goes on the
   * verification's audit row beside both values; the client is told which
   * details changed. Any non-blank length, like every reviewer reason.
   */
  @ApiPropertyOptional({
    example: 'Surname misspelt at registration; the passport reads "Haddad".',
    maxLength: 500,
    description: 'Required when a verified detail changes. Recorded on the audit row.',
  })
  @Transform(({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value))
  @IsOptional()
  @IsString()
  @MaxLength(500)
  reason?: string;
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
  /*
   * `value` is typed `unknown` rather than left implicit. class-transformer hands
   * it as `any`, and returning that from a transform is an unsafe-return the lint
   * gate counts — the narrowing below is what the rule wants to see anyway.
   */
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim().toLowerCase() : value,
  )
  @IsEmail({}, { message: 'A valid email address is required.' })
  @MaxLength(255)
  email: string;
}

/**
 * Body of `PATCH /admin/clients/:id/referrer`.
 *
 * ⚠️ A REFERRAL CODE, NEVER A PARTNER ID, and the input type is what keeps this
 * route from being a different power.
 *
 * Support is holding what the CLIENT told them — "I used PARTNER01". An id
 * forces the operator to look a partner up, and looking up means picking one
 * off a list, which is the shape of CHOOSING WHO GETS PAID. Resolving a code the
 * client supplied REPAIRS an attribution that existed; picking from a list
 * CREATES one. Those are different powers wearing the same HTTP verb.
 */
export class SetClientReferrerDto {
  @ApiProperty({
    example: 'PARTNER01',
    description:
      'The partner\u2019s referral code, as the client reports it. Case-insensitive and ' +
      'trimmed, exactly as registration resolves it. Refused with distinct codes when it ' +
      'matches no partner, names the client themselves, or names a suspended partner.',
  })
  @IsString()
  @IsNotEmpty()
  referralCode: string;
}
