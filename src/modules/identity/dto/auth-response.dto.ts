import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
export { MessageResponseDto } from '../../../common/dto/message-response.dto';

// Response DTOs for the client-portal auth surface.
//
// `AuthController` carried no @ApiOkResponse, so the portal hand-wrote
// `UserProfile` in src/context/UserContext.tsx and `AuthResponse` in
// src/lib/api/auth.ts. Its hand-written copy drifted: it declared `role` and
// `isEmailVerified` on the user, neither of which `sanitize()` returns.
//
// Shapes below are transcribed from the live responses, not from the service
// source, so they describe what callers actually receive.

const USER_TYPES = ['individual', 'corporate'] as const;
const USER_STATUSES = ['active', 'suspended'] as const;

export class UserProfileDto {
  @ApiProperty() id: string;
  @ApiProperty({ example: 'client@oxshare.com' }) email: string;
  @ApiProperty({ example: 'John' }) firstName: string;
  @ApiProperty({ example: 'Doe' }) lastName: string;
  @ApiProperty({ enum: USER_TYPES }) type: (typeof USER_TYPES)[number];
  @ApiProperty({ enum: USER_STATUSES }) status: (typeof USER_STATUSES)[number];

  @ApiProperty({
    description: 'KYC tier. 0 = unverified, 1 = approved.',
    example: 1,
  })
  verificationLevel: number;

  @ApiProperty() emailVerified: boolean;

  @ApiPropertyOptional({ example: 'United Arab Emirates' }) country?: string;
  @ApiPropertyOptional({ example: '+971501234567' }) phone?: string;
  @ApiProperty() createdAt: Date;
}

/**
 * `POST /auth/login`, `/auth/refresh`.
 *
 * **No tokens in the body, deliberately.** The session is set as httpOnly
 * cookies on the same response (PLATFORM-CONVENTIONS R-3.2); returning the
 * tokens as well would hand JavaScript the exact credential that flag exists to
 * keep away from it. While these fields existed, a portal running the previous
 * build kept reading them and writing its own JS-readable `access_token` cookie,
 * so clearing the browser and logging in again recreated the very exposure the
 * migration removed.
 *
 * The name is now a slight misnomer — it carries no tokens — but renaming an
 * exported DTO that both frontends alias is a separate, mechanical change.
 *
 * **snake_case, deliberately.** The portal endpoints answer `access_token` /
 * `refresh_token` while the admin API answers camelCase `accessToken` /
 * `refreshToken`. That divergence is frozen: renaming a live auth contract across
 * three separately-deployed repos risks logging out every session for no
 * functional gain, since both services also set cookies. Documented here so the
 * portal can alias this type instead of asserting the shape inline, and so the
 * asymmetry is visible in the generated types rather than folklore.
 *
 * New endpoints should use camelCase.
 */
export class AuthTokensResponseDto {
  @ApiProperty({ type: UserProfileDto })
  user: UserProfileDto;

  @ApiProperty({ description: 'Mirrors user.emailVerified; kept for older portal builds.' })
  emailVerified: boolean;
}

/**
 * `POST /auth/register`.
 *
 * Registration does NOT return tokens — the account is unverified until the
 * emailed link is followed, so there is no session to hand back yet. This was
 * briefly documented as returning AuthTokensResponseDto, which was simply wrong;
 * the portal's `register` page reads `.message`, and aliasing the generated type
 * turned that mistake into a compile error in the portal. Transcribed from the
 * live response.
 */
export class RegistrationResponseDto {
  @ApiProperty({
    example: 'Registration successful. Please check your email to verify your account.',
  })
  message: string;

  /**
   * OPTIONAL, and that is the point.
   *
   * Registration answers identically whether or not an account already exists,
   * so that it is not a membership oracle (auth.service.ts). When one does, no
   * account is created and there is no id to return — returning the EXISTING
   * user's id would hand back the exact fact the generic message hides.
   */
  @ApiPropertyOptional({
    description:
      'The new user id. Absent when no account was created — including when one already existed, ' +
      'which this endpoint deliberately does not disclose. No session exists until the email is verified.',
  })
  userId?: string;
}
