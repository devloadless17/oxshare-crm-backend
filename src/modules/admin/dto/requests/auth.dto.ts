import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsArray,
  IsBoolean,
  IsEmail,
  IsNotEmpty,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
} from 'class-validator';

/*
 * Bounds, matching modules/identity/dto/auth.dto.ts rather than being decided
 * again here. These DTOs were written separately from the portal's and capped
 * nothing, so the same question had two answers depending on which door you
 * came through, and both answers were wrong on this side.
 *
 * NAME_MAX mirrors the `varchar(100)` on `admins.name` and
 * `admin_invites.name`. Without it an over-long name reached Postgres and came
 * back as a driver error — a 500 on an admin's own invite form, where naming
 * the offending field in a 400 is the entire purpose of having a DTO.
 *
 * PASSWORD_MAX matters because argon2's cost grows with input length and the
 * endpoints that hash are deliberately UNAUTHENTICATED. The throttles bound how
 * OFTEN a request arrives; nothing bounded how expensive one could be.
 */
const NAME_MAX = 100;
const EMAIL_MAX = 255;
const PASSWORD_MAX = 100;

// Request DTOs for the admin auth + invite surface.
//
// These were declared inline inside admin.controller.ts. Two problems with that:
// the controller grew to 717 lines, and — because they carried no @ApiProperty —
// every one of them generated into /api/docs-json as `Record<string, never>`.
// The admin app therefore hand-wrote the request shapes it sends, which is the
// exact drift the generated types exist to prevent (API-CONTRACTS Part C).
//
// class-validator decorators are paired with @ApiProperty on every field, per
// modules/identity/dto/auth.dto.ts. The global ValidationPipe can only validate
// a @Body() that has a DTO *class* to reflect on, so these are load-bearing for
// input validation as well as for documentation.

export class AdminLoginDto {
  @ApiProperty({ example: 'admin@oxshare.com' })
  @IsEmail()
  email: string;

  @ApiProperty({ example: 'admin123', maxLength: PASSWORD_MAX })
  @IsString()
  @MaxLength(PASSWORD_MAX)
  password: string;
}

export class InviteDto {
  @ApiProperty({ example: 'new.admin@oxshare.com', maxLength: EMAIL_MAX })
  @IsEmail()
  @MaxLength(EMAIL_MAX)
  email: string;

  @ApiProperty({ example: 'Jane Doe', maxLength: NAME_MAX })
  @IsString()
  @MaxLength(NAME_MAX)
  name: string;

  /** Assign an existing role. Mutually exclusive in practice with `permissions`. */
  @ApiPropertyOptional({ description: 'Existing role id to assign on acceptance.' })
  @IsString()
  @IsOptional()
  roleId?: string;

  @ApiPropertyOptional({
    type: [String],
    description: 'Explicit permission keys, when not assigning a role.',
  })
  @IsArray()
  @IsOptional()
  permissions?: string[];

  /*
   * Territory and masking, chosen HERE rather than after acceptance.
   *
   * `admin_invites` has carried both columns since the scoping work, with a
   * comment in schema.ts stating exactly why they must be settable at invite
   * time: an EMPTY scope means unrestricted, so assigning territory only after
   * acceptance leaves every newly-accepted sub-admin able to see every client in
   * the system for the window between them clicking the emailed link and a
   * master admin remembering to configure them — a window nobody observes,
   * because it opens and closes in a mailbox we do not watch.
   *
   * The columns existed; nothing wrote them and nothing read them, so the window
   * described in that comment was open. These two fields close it.
   */
  @ApiPropertyOptional({
    type: [String],
    description:
      'Client fields this admin may not see. Omit to inherit the role’s mask; [] means no mask.',
  })
  @IsArray()
  @IsOptional()
  maskedFields?: string[];

  @ApiPropertyOptional({
    type: [String],
    description:
      'Client tags this admin is scoped to. Omit or [] means UNRESTRICTED — every client.',
  })
  @IsArray()
  @IsOptional()
  scopedTagIds?: string[];

  @ApiPropertyOptional({
    description:
      'D-60 — sees the intake pool: clients with no tag assignments yet. Meaningful only for a scoped admin. DEFAULTS TO TRUE — restriction is the explicit act; an inviter who does not see the pool cannot grant it, and their default resolves to false.',
  })
  @IsBoolean()
  @IsOptional()
  seesUntriaged?: boolean;
}

/**
 * The token on `GET /admin/invite/validate`.
 *
 * A DTO rather than a bare `@Query('token') token: string`, because the global
 * ValidationPipe has nothing to reflect on without one — the parameter is typed
 * `string`, TypeScript erases that at runtime, and an ABSENT token arrived as
 * `undefined`, reached the store, and came back as a 500 INTERNAL_ERROR.
 *
 * The distinction matters beyond tidiness. A caller who omits the parameter has
 * made a bad request and can fix it; a 500 says the server broke and invites a
 * bug report, and it logs at error level so a routine mistake looks like an
 * incident. The same route already answers 400 for a token that is present but
 * unknown, so the two "bad token" cases now agree.
 */
export class ValidateInviteQueryDto {
  @ApiProperty({
    example: 'e0b8b3f2-3c1a-4f6e-9a7d-2f5c8b1d4e6a',
    description: 'The invite token from the emailed link.',
  })
  @IsString()
  @IsNotEmpty()
  token: string;
}

export class AcceptInviteDto {
  @ApiProperty({ description: 'Single-use token from the invitation email.' })
  @IsString()
  token: string;

  @ApiProperty({ minLength: 8, maxLength: PASSWORD_MAX })
  @IsString()
  @MinLength(8)
  @MaxLength(PASSWORD_MAX)
  password: string;
}

/**
 * The body for spending a reset link. Same shape as accepting an invite,
 * deliberately kept a SEPARATE class rather than reused: the two carry
 * different credentials with different lifetimes, and a shared DTO is how a
 * later change to one silently loosens the other.
 */
export class CompleteAdminResetDto {
  @ApiProperty({ description: 'Single-use token from the password reset email.' })
  @IsString()
  token: string;

  @ApiProperty({ minLength: 8, maxLength: PASSWORD_MAX })
  @IsString()
  @MinLength(8)
  @MaxLength(PASSWORD_MAX)
  password: string;
}

/**
 * Change your own password from inside a live session.
 *
 * Not `CompleteAdminResetDto`, which spends an e-mailed token and exists for
 * somebody who CANNOT sign in. Using that flow for a signed-in administrator
 * would mean mailing them a link to prove an identity they have already proved.
 *
 * `currentPassword` is capped but not floored: it is checked against a stored
 * hash, never created, so a minimum here would only reject the true password of
 * an account whose rules were laxer when it was set.
 */
export class AdminChangePasswordDto {
  @ApiProperty({ maxLength: PASSWORD_MAX })
  @IsString()
  @MaxLength(PASSWORD_MAX)
  currentPassword: string;

  @ApiProperty({ minLength: 8, maxLength: PASSWORD_MAX })
  @IsString()
  @MinLength(8)
  @MaxLength(PASSWORD_MAX)
  newPassword: string;
}

/**
 * Change your own display name.
 *
 * The NAME only. `email` is deliberately absent and must stay absent: it is the
 * login credential and the address every reset link is sent to, so a
 * self-service change would move an account to an inbox its owner may no longer
 * control. See `AdminProfileService.updateProfile`.
 */
export class AdminUpdateProfileDto {
  @ApiProperty({ maxLength: NAME_MAX, example: 'Ada Lovelace' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(NAME_MAX)
  name: string;
}
