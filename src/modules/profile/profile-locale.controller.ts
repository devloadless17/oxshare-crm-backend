import { Body, Controller, HttpCode, HttpStatus, Put, Req, UseGuards } from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiCookieAuth,
  ApiNoContentResponse,
  ApiOperation,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import type { Request } from 'express';
import { JwtAuthGuard } from '../identity/guards/jwt-auth.guard';
import { UsersStore, type User } from '../../store/users.store';
import { UpdateProfileLocaleDto } from './dto/profile-locale.dto';

/**
 * The client's portal language (2 Oct 2026).
 *
 * The portal sends `X-OxShare-Locale` on every request, which is enough for
 * anything written while the client is there. It is NOT enough for what is
 * written while they are away — a KYC decision, a payout, a credit — so the
 * portal tells us here when they switch, and those mails read `users.locale`.
 *
 * Its own controller rather than a route on `ProfileOptionsController`: that
 * one is PUBLIC (the registration form reads it), and this one is a
 * session-bound write. The owner comes from the session, never a parameter.
 * CSRF is the global `CsrfGuard`, like every portal write.
 */
@ApiTags('profile')
@Controller('profile')
export class ProfileLocaleController {
  constructor(private readonly users: UsersStore) {}

  @Put('locale')
  @UseGuards(JwtAuthGuard)
  @ApiCookieAuth()
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    summary: "Set the client's portal language",
    description:
      'Stores `en` or `ar` on the account. Emails sent outside the client’s own requests ' +
      '(review decisions, payouts, credits) are written in it.',
  })
  @ApiNoContentResponse({ description: 'Stored.' })
  @ApiBadRequestResponse({ description: 'The locale is not one of `en`, `ar`.' })
  @ApiUnauthorizedResponse({ description: 'No client session.' })
  async setLocale(
    @Body() dto: UpdateProfileLocaleDto,
    @Req() req: Request & { user: User },
  ): Promise<void> {
    await this.users.update(req.user.id, { locale: dto.locale });
  }
}
