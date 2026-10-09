import {
  IsEmail,
  IsString,
  IsNotEmpty,
  Matches,
  MinLength,
  MaxLength,
  IsOptional,
} from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

/**
 * A registration — the account, and the client profile it starts with.
 *
 * The decorators bound SHAPE (strings, lengths); the RULES — a name made of
 * letters, a real date of birth at least 18 years back, a dialable phone, a
 * country and nationality from the KYC lists — are `common/profile/
 * client-profile.ts`, applied by `AuthService.register` and by every later
 * writer, so a value registration accepts is one KYC accepts too.
 */
export class RegisterDto {
  @ApiProperty({ example: 'John', maxLength: 100, description: 'As on the ID document.' })
  @IsString()
  @MaxLength(100)
  firstName: string;

  @ApiProperty({ example: 'Doe', maxLength: 100, description: 'As on the ID document.' })
  @IsString()
  @MaxLength(100)
  lastName: string;

  @ApiProperty({ example: 'john@example.com' })
  @IsEmail()
  email: string;

  @ApiProperty({ example: 'StrongPass123!', minLength: 8 })
  @IsString()
  @MinLength(8)
  @MaxLength(100)
  password: string;

  @ApiPropertyOptional({
    example: '1990-04-12',
    description: 'YYYY-MM-DD. At least 18 years ago.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(10)
  dateOfBirth?: string;

  @ApiPropertyOptional({ example: 'Lebanese', description: 'From the KYC nationality list.' })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  nationality?: string;

  @ApiPropertyOptional({
    example: '+96170123456',
    description: 'International format with the country code. Stored as E.164.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(32)
  phone?: string;

  @ApiPropertyOptional({
    example: 'Lebanon',
    description: 'Country of residence, from the KYC country list.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  country?: string;

  @ApiPropertyOptional({ example: 'Hamra Street, Building 12, 3rd floor', maxLength: 200 })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  address?: string;

  @ApiPropertyOptional({ example: 'Beirut', maxLength: 100 })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  city?: string;

  @ApiPropertyOptional({
    example: '1103 2080',
    maxLength: 12,
    description: 'Optional — many addresses have none.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(12)
  postalCode?: string;

  /**
   * A partner's referral code, from the `?ref=` on the link they shared.
   *
   * Optional, and an unknown or retired code does NOT refuse the registration —
   * `AuthService` logs it and leaves the client unattributed. A referral link is
   * marketing collateral that gets copied, truncated and retyped; refusing a
   * signup because one arrived wrong would cost a real client to protect a
   * bookkeeping detail.
   *
   * Length matches `ib_accounts.referral_code`.
   */
  @ApiPropertyOptional({ example: 'K7M2PQR9', maxLength: 50 })
  @IsOptional()
  @IsString()
  @MaxLength(50)
  referralCode?: string;

  /**
   * An administrator's sign-up link code (0195) — `/join/<code>` on the portal.
   * The client arrives carrying the link's tags, i.e. in that administrator's
   * book. Unknown, switched off, or owned by a suspended administrator: the
   * sign-up goes through with no tag — never refused.
   */
  @ApiPropertyOptional({ example: 'K7M2Q9XA', maxLength: 32 })
  @IsOptional()
  @IsString()
  @MaxLength(32)
  acquisitionCode?: string;
}

export class LoginDto {
  @ApiProperty({ example: 'john@example.com' })
  @IsEmail()
  email: string;

  /*
   * Capped like registration, which has always capped at 100.
   *
   * Login was the one password field with no upper bound, on an endpoint that is
   * unauthenticated by definition and runs argon2 on whatever arrives. The
   * throttle bounds how often that happens; it did not bound the cost of one
   * request. No account can hold a longer password — register and reset both
   * cap at 100 — so nothing legitimate is refused by this.
   */
  @ApiProperty({ example: 'StrongPass123!', maxLength: 100 })
  @IsString()
  @MaxLength(100)
  password: string;

  @ApiPropertyOptional({ example: 'CLIENT' })
  @IsOptional()
  @IsString()
  role?: string;
}

export class VerifyEmailDto {
  @ApiProperty({
    example: 'a1b2c3d4e5f6',
    description: 'The single-use token from the verification email link.',
  })
  @IsString()
  @IsNotEmpty()
  token: string;
}

/** The 6-digit code from the verification email — see `AuthService.verifyEmailCode`. */
export class VerifyEmailCodeDto {
  @ApiProperty({ example: 'john@example.com' })
  @IsEmail()
  email: string;

  @ApiProperty({ example: '482913', description: 'The 6-digit code from the verification email.' })
  @IsString()
  @Matches(/^\d{6}$/, { message: 'Enter the 6-digit code from the email.' })
  code: string;
}

export class ResendVerificationDto {
  @ApiProperty({ example: 'john@example.com' })
  @IsEmail()
  email: string;
}

export class ForgotPasswordDto {
  @ApiProperty({ example: 'john@example.com' })
  @IsEmail()
  email: string;
}

export class ResetPasswordDto {
  @ApiProperty({ description: 'The token from the emailed reset link.' })
  @IsString()
  @MinLength(1)
  token: string;

  /**
   * The same rules registration applies.
   *
   * Deliberately identical: a reset path with weaker rules is a way to get a
   * password past the policy, and it would be the path an attacker who already
   * has inbox access would choose.
   */
  @ApiProperty({ example: 'StrongPass123!', minLength: 8 })
  @IsString()
  @MinLength(8)
  @MaxLength(100)
  newPassword: string;
}

/**
 * Changing a password from inside a live session.
 *
 * `currentPassword` is required and is the whole point: without it this
 * endpoint turns any XSS, any borrowed unlocked laptop and any session cookie
 * into a permanent account takeover, because a password outlives every cookie
 * that could be revoked.
 *
 * The bounds match `RegisterDto` and `ResetPasswordDto` exactly. A different
 * minimum here would mean a password this API accepts on one route and refuses
 * on another, and the client finding that out only at the point of failure.
 */
export class ChangePasswordDto {
  @ApiProperty({ example: 'CurrentPass123!', maxLength: 100 })
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  currentPassword: string;

  @ApiProperty({ example: 'NewStrongPass123!', minLength: 8, maxLength: 100 })
  @IsString()
  @MinLength(8)
  @MaxLength(100)
  newPassword: string;
}

/**
 * `POST /auth/register/email-available` — the sign-up form's first step asks
 * whether the address is free before the client types their details.
 */
export class EmailAvailabilityDto {
  @ApiProperty({ example: 'john@example.com' })
  @IsEmail()
  email: string;
}
