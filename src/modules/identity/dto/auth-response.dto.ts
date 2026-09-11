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

// The DERIVED client type (users.store.ts): partner ▸ referral ▸ individual.
// `corporate` never existed in the enum, and `referral`/`partner` were missing —
// this DTO is what the portal generates its types from.
const USER_TYPES = ['individual', 'referral', 'partner'] as const;
const USER_STATUSES = ['active', 'suspended', 'pending'] as const;

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

  @ApiPropertyOptional({
    type: String,
    nullable: true,
    description:
      'Path to the profile photo, or null when there is none. The portal renders initials for ' +
      'null rather than a placeholder image or a gravatar - an invented image URL would be a ' +
      "request to a third party leaking the client's e-mail hash.",
    example: '/uploads/avatars/6f1c2b9e-....png',
  })
  avatarUrl: string | null;
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
 * `POST /auth/refresh`.
 *
 * Its own type because refresh returns `{ user }` and NOTHING ELSE, while it was
 * documented as returning `AuthTokensResponseDto` — whose `emailVerified` is
 * required. So the generated portal type declared a field the endpoint never
 * sends, on the one call that decides whether a client stays signed in.
 *
 * Transcribed from the live response rather than from the adjacent DTO, which is
 * how the mismatch survived: the two endpoints look interchangeable and are not.
 */
export class RefreshResponseDto {
  @ApiProperty({ type: UserProfileDto })
  user: UserProfileDto;
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

  /*
   * ⚠️ THERE IS NO `userId` HERE, AND ITS ABSENCE IS THE WHOLE POINT.
   *
   * This response carried an optional `userId` until 11 Sep 2026, with a
   * docblock explaining that it was omitted when an account already existed
   * "which this endpoint deliberately does not disclose".
   *
   * It disclosed it. Everything around the omission was right — the same 201,
   * the same message, an email to the real holder, no throw — and the PRESENCE
   * OF THE KEY was the oracle. POST an address, read one field, learn whether
   * it holds an account. Measured on the wire: identical status, identical
   * message, `userId` present for a new address and absent for `client@…`.
   *
   * The field is GONE rather than faked. Nothing read it — one docblock in the
   * portal's `lib/api/auth.ts` described the shape and no caller touched it —
   * and a fabricated id would be a lie in a response body that somebody
   * eventually trusts. With the field removed the two bodies are byte-identical
   * and there is no value to keep in step.
   *
   * `auth-registration-oracle.spec.ts` asserts the two responses are IDENTICAL
   * rather than that this key is absent: "no userId for an existing address"
   * would pass against a response that later grew a `createdAt` or a
   * `verified: false`. The property is INDISTINGUISHABILITY, not the absence of
   * one field.
   */
}

/**
 * `POST /auth/verify-email`.
 *
 * ## Why there is a `status` and not just a message
 *
 * Verification is IDEMPOTENT (auth.service.ts): clicking a link twice is not an
 * error, and both outcomes are a 200 because both are true — the address is
 * verified either way and the caller's next step is identical. The screen still
 * has to tell them apart, because "Email verified" and "you already did this,
 * go and sign in" are different sentences.
 *
 * The discriminator is a machine-readable enum for the reason every error in
 * this system carries a `code`: the portal used to branch on the ENGLISH TEXT of
 * `message`, which breaks on a copy edit and again on the day Arabic ships (FSD
 * §10 / D-16). A client should never have to read prose to make a decision.
 *
 * Additive — a `message`-only reader behaves exactly as it did before.
 */
export class VerifyEmailResponseDto {
  @ApiProperty({
    enum: ['verified', 'already_verified'],
    description:
      'verified — this call redeemed the link. already_verified — the link had already been ' +
      'redeemed and the address is confirmed. Branch on this, never on `message`.',
    example: 'verified',
  })
  status: 'verified' | 'already_verified';

  @ApiProperty({ example: 'Email verified successfully. You can now log in.' })
  message: string;
}

/**
 * One live session, as `GET /auth/sessions` returns it.
 *
 * A session is a refresh-token FAMILY, not a token row — one login starts a
 * family and every fifteen-minute rotation appends to it, so a client signed in
 * for a month on one laptop is thousands of rows and exactly one entry here.
 *
 * Published as a DTO rather than left implicit because the portal generates its
 * types from this document (R-1.2). The two fields most likely to drift are
 * `id` (a FAMILY id, which is what DELETE takes) and `current` (which the UI
 * uses to refuse to revoke the session the client is sitting in).
 */
export class SessionDto {
  @ApiProperty({ description: 'Refresh-token family id. Pass this to DELETE /auth/sessions/:id.' })
  id: string;

  @ApiProperty({ description: 'When this session signed in.', format: 'date-time' })
  createdAt: string;

  @ApiProperty({
    description: 'Last time this session refreshed — how "active" is measured.',
    format: 'date-time',
  })
  lastActiveAt: string;

  @ApiProperty({ description: 'When it expires on its own if unused.', format: 'date-time' })
  expiresAt: string;

  @ApiPropertyOptional({
    type: String,
    description:
      'Most recent User-Agent seen on this session. Null for sessions predating capture.',
    nullable: true,
    example: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
  })
  userAgent: string | null;

  @ApiPropertyOptional({
    type: String,
    description: 'Most recent client address. Null for sessions predating capture.',
    nullable: true,
    example: '203.0.113.7',
  })
  ip: string | null;

  @ApiProperty({
    description:
      'True for the session making this request. Resolved from the refresh cookie, not the access token.',
  })
  current: boolean;
}

/** What the avatar routes answer: the new URL, or null once removed. */
export class AvatarResponseDto {
  @ApiPropertyOptional({
    type: String,
    nullable: true,
    description:
      'Path to the stored photo, or null when there is none. Composed from the stored filename, ' +
      'so the section 8.5 move to private object storage changes this line and no rows.',
    example: '/uploads/avatars/6f1c...c2.png',
  })
  avatarUrl: string | null;
}
