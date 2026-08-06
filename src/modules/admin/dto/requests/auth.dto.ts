import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsArray, IsEmail, IsOptional, IsString, MaxLength, MinLength } from 'class-validator';

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
