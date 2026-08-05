import { IsEmail, IsString, IsNotEmpty, MinLength, MaxLength, IsOptional } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class RegisterDto {
  @ApiProperty({ example: 'John' })
  @IsString()
  @MaxLength(50)
  firstName: string;

  @ApiProperty({ example: 'Doe' })
  @IsString()
  @MaxLength(50)
  lastName: string;

  @ApiProperty({ example: 'john@example.com' })
  @IsEmail()
  email: string;

  @ApiProperty({ example: 'StrongPass123!', minLength: 8 })
  @IsString()
  @MinLength(8)
  @MaxLength(100)
  password: string;

  @ApiPropertyOptional({ example: 'US' })
  @IsOptional()
  @IsString()
  country?: string;

  @ApiPropertyOptional({ example: '+1234567890' })
  @IsOptional()
  @IsString()
  phone?: string;
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
