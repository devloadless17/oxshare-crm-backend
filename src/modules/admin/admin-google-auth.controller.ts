import {
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import {
  ApiCookieAuth,
  ApiFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiQuery,
  ApiTags,
} from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import type { Request, Response } from 'express';
import { deviceOf } from '../../common/security/device-fingerprint';
import { Admin } from '../../store/admins.store';
import { AdminAuthService } from './admin-auth.service';
import { AdminGoogleAuthService } from './google/admin-google-auth.service';
import { GoogleSignInStatusDto, MessageResponseDto } from './dto/responses.dto';
import { AdminGuard, AnyAdmin, PermissionsGuard, RequirePermissions } from './guards/admin.guard';
import { NotClientScoped } from './guards/client-scope.decorator';
import { Audited } from './guards/audited.decorator';

/**
 * "Sign in with Google" for the ADMIN console — part of the `admin` controller
 * surface, so RBAC-08's IP allowlist and the origin rules apply exactly as
 * they do to password sign-in.
 *
 * `start` and `callback` are top-level browser NAVIGATIONS (GET), answered
 * with a 302 rather than JSON. `CsrfGuard` only inspects state-changing verbs,
 * so neither needs `@NoCsrf`; the flow's own `state` + signed cookie + PKCE
 * are what bind the callback to the browser that started it.
 */
@ApiTags('admin')
@Controller('admin')
export class AdminGoogleAuthController {
  constructor(
    private readonly google: AdminGoogleAuthService,
    private readonly auth: AdminAuthService,
  ) {}

  @Get('auth/google/status')
  @Throttle({ default: { ttl: 60_000, limit: 60 } })
  @ApiOperation({ summary: 'Whether the admin sign-in screen offers "Sign in with Google"' })
  @ApiOkResponse({ type: GoogleSignInStatusDto })
  @NotClientScoped('Reports a configuration flag; reads no rows at all.')
  status(): GoogleSignInStatusDto {
    return { enabled: this.google.isEnabled() };
  }

  @Get('auth/google/start')
  // Each call mints a flow and sends the browser to Google: cheap, but a
  // ceiling keeps it from being a free redirect generator.
  @Throttle({ default: { ttl: 60_000, limit: 20 } })
  @ApiOperation({
    summary: 'Begin Google sign-in (browser navigation; 302 to Google)',
    description:
      'Sets a signed, httpOnly flow cookie (state, nonce, PKCE verifier) and redirects to ' +
      "Google's authorization endpoint. `next` must be a relative console path; anything else " +
      'lands on /dashboard. `invite` (the emailed invite token) is kept in the cookie only.',
  })
  @ApiQuery({ name: 'next', required: false, type: String })
  @ApiQuery({ name: 'invite', required: false, type: String })
  @ApiFoundResponse({ description: 'Redirect to Google, or back to the console when disabled.' })
  @NotClientScoped('Starts an administrator sign-in; reads no client rows.')
  start(@Req() req: Request, @Res() res: Response): void {
    const query = req.query as Record<string, unknown>;
    const url = this.google.start({ next: query.next, invite: query.invite }, res);
    res.setHeader('Cache-Control', 'no-store');
    res.redirect(HttpStatus.FOUND, url);
  }

  @Get('auth/google/callback')
  // A credential exchange, like password login (5/min). Higher because a
  // legitimate person may bounce between accounts in Google's chooser.
  @Throttle({ default: { ttl: 60_000, limit: 20 } })
  @ApiOperation({
    summary: 'Google redirects here (browser navigation; 302 back to the console)',
    description:
      'Verifies state against the signed flow cookie, exchanges the code with the PKCE verifier, ' +
      'verifies the ID token and starts an admin session. Every failure redirects to the console ' +
      'with `?google_error=<code>` — never Google text, never the address.',
  })
  @ApiQuery({ name: 'code', required: false, type: String })
  @ApiQuery({ name: 'state', required: false, type: String })
  @ApiQuery({ name: 'error', required: false, type: String })
  @ApiFoundResponse({ description: 'Redirect to the console.' })
  @NotClientScoped('Completes an administrator sign-in; reads no client rows.')
  async callback(@Req() req: Request, @Res() res: Response): Promise<void> {
    /*
     * The query is read raw rather than through a DTO: Google appends its own
     * parameters (scope, authuser, prompt, hd, iss…), and the global pipe's
     * `forbidNonWhitelisted` would turn the next one Google adds into a 400 on
     * every sign-in. The three that matter are type-checked in the service.
     */
    const url = await this.google.callback(req.query, req, res, deviceOf(req));
    res.setHeader('Cache-Control', 'no-store');
    res.redirect(HttpStatus.FOUND, url);
  }

  @AnyAdmin(
    "Removes a sign-in method from the CALLER's own account. Needing a permission to stop " +
      'trusting your own Google account would be backwards.',
  )
  @Delete('auth/me/google')
  @UseGuards(AdminGuard)
  @HttpCode(HttpStatus.OK)
  @ApiCookieAuth()
  @ApiOperation({ summary: 'Unlink your own Google account' })
  @ApiOkResponse({ type: MessageResponseDto })
  @NotClientScoped("Edits the calling administrator's own row; reads no client rows.")
  @Audited('admin.google_unlink')
  unlinkOwn(@Req() req: Request & { admin: Admin }) {
    return this.auth.unlinkOwnGoogle(req.admin.id);
  }

  /**
   * Unlink ANOTHER administrator's Google account — `admins.reset`, plus the
   * same escalation guard a password reset applies (`refuseReset`): changing
   * how somebody proves who they are is the same class of act.
   */
  @Delete('users/:id/google')
  @UseGuards(PermissionsGuard)
  @RequirePermissions('admins.reset')
  @Throttle({ default: { ttl: 60_000, limit: 10 } })
  @HttpCode(HttpStatus.OK)
  @ApiCookieAuth()
  @ApiOperation({ summary: "Unlink another administrator's Google account (admins.reset)" })
  @ApiOkResponse({ type: MessageResponseDto })
  @NotClientScoped('Acts on an administrator account; reads no client rows.')
  @Audited('admin.google_unlink')
  unlinkFor(@Param('id', ParseUUIDPipe) id: string, @Req() req: Request & { admin: Admin }) {
    return this.auth.unlinkGoogleFor(req.admin.id, id);
  }
}
