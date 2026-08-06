// Part of the `admin` controller surface, split by concern.
//
// admin.controller.ts had grown to 717 lines fronting six already well-separated
// services. Nest allows several controllers to share one @Controller prefix, so
// this split changes no route path — test/openapi-routes.spec.ts asserts the full
// 69-route inventory is byte-identical, which is what made the split safe to do.
//
// All guards here are per-route; there is no class-level @UseGuards to preserve.
// @ApiTags('admin') is repeated on each class so Swagger still groups them as one
// tag and the generated types.gen.ts is unchanged.

import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Query,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import { ApiCookieAuth, ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { Request, Response } from 'express';
import { AdminAuthService } from './admin-auth.service';
import { Admin } from '../../store/admins.store';
import { AcceptInviteDto, AdminLoginDto, InviteDto } from './dto/requests/auth.dto';
import {
  AdminLoginResponseDto,
  AcceptInviteResponseDto,
  AdminProfileDto,
  InviteResponseDto,
  InviteValidationDto,
  MessageResponseDto,
  PendingInviteDto,
} from './dto/responses.dto';
import { AnyAdmin, AdminGuard, PermissionsGuard, RequirePermissions } from './guards/admin.guard';
import { NoCsrf } from '../../common/security/csrf.guard';
import { UuidParam } from '../../common/query-params';
import { NotClientScoped } from './guards/client-scope.decorator';
import { Audited, NotAudited } from './guards/audited.decorator';

/** Admin sign-in, session refresh and the invitation flow. */
@ApiTags('admin')
@Controller('admin')
export class AdminAuthController {
  constructor(private readonly auth: AdminAuthService) {}

  // ── Auth ──────────────────────────────────────────────────────────────────
  @NoCsrf(
    'Establishing a session cannot be a forgery of one: there is nothing yet to ' +
      'protect. Requiring a token here also creates a lockout — an expired or ' +
      'absent token would make it impossible to log in and obtain a fresh one.',
  )
  @Post('auth/login')
  // Master-admin credentials: 5 attempts per minute per IP. Unprotected before.
  @Throttle({ default: { ttl: 60_000, limit: 5 } })
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Admin login' })
  @ApiOkResponse({ type: AdminLoginResponseDto })
  @NotClientScoped('Public credential exchange. No client rows are read.')
  @NotAudited(
    'Success and failure both land in `login_attempts`, which is the table built for credential events and carries the lockout counter. Duplicating them here would flood the action log with the one event that already has a home.',
  )
  login(@Body() dto: AdminLoginDto, @Res({ passthrough: true }) res: Response) {
    return this.auth.login(dto.email, dto.password, res);
  }

  @NoCsrf(
    'Rotating a session the caller already holds grants no new authority, and a ' +
      'refresh must keep working when the CSRF token has expired alongside the ' +
      'access token — otherwise a returning user is locked out rather than renewed.',
  )
  @Post('auth/refresh')
  // Same reasoning as the portal's refresh route (R-3.5): CSRF-exempt by
  // design, hashes on every call, and was left at the global 120/min. 20/min is
  // far above any real admin session and puts a ceiling on the cost.
  @Throttle({ default: { ttl: 60_000, limit: 20 } })
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Admin refresh token' })
  @ApiOkResponse({ type: AdminLoginResponseDto })
  @NotClientScoped('Token rotation only; reads no client rows.')
  @NotAudited(
    'Token rotation, every fifteen minutes per signed-in admin. Recording it would bury every real action under machine noise, and reuse detection already alarms on the case that matters.',
  )
  refresh(@Req() req: Request, @Res({ passthrough: true }) res: Response) {
    return this.auth.refresh(req, res);
  }

  @NoCsrf(
    'Ending a session is not an attack worth defending against, and blocking it ' +
      'when the token is missing would leave a user unable to log out — strictly ' +
      'worse for them than the nuisance it prevents.',
  )
  @AnyAdmin(
    'Ending your own session requires no privilege beyond having one, and gating it behind a ' +
      'permission would leave an admin unable to log out of a panel they can already see.',
  )
  @Post('auth/logout')
  /*
   * NO AdminGuard, deliberately — see `AdminAuthService.logout`.
   *
   * Behind the guard, an expired access token meant 401 and no cookies cleared,
   * so an admin returning to a slept laptop could not sign out at all. Identity
   * is taken from the fully-verified refresh cookie instead, and the cookies are
   * cleared either way. Origin validation still applies: `@NoCsrf` waives the
   * anti-forgery token, not the origin check.
   */
  @HttpCode(HttpStatus.OK)
  @ApiCookieAuth()
  @ApiOperation({ summary: 'Admin logout' })
  @ApiOkResponse({ type: MessageResponseDto })
  @NotClientScoped("Revokes the caller's own session; reads no client rows.")
  @NotAudited(
    "Ends the calling administrator's own session and changes nothing another administrator could later need explained.",
  )
  logout(@Req() req: Request, @Res({ passthrough: true }) res: Response) {
    return this.auth.logout(req, res);
  }

  @AnyAdmin(
    'Returns the caller their OWN profile and resolved permissions. Every admin needs it on ' +
      'every page load — it is what the nav gates on — and it exposes nothing they do not already hold.',
  )
  @Get('auth/me')
  @UseGuards(AdminGuard)
  @ApiCookieAuth()
  @ApiOperation({ summary: 'Get current admin' })
  @ApiOkResponse({ type: AdminProfileDto })
  @NotClientScoped(
    "Returns the CALLING ADMIN's own profile, which is an admins row, not a client one.",
  )
  me(@Req() req: Request & { admin: Admin }) {
    return this.auth.me(req.admin);
  }

  // ── Invite ────────────────────────────────────────────────────────────────
  @Post('invite')
  @UseGuards(PermissionsGuard)
  @RequirePermissions('users.create')
  @ApiCookieAuth()
  @ApiOperation({
    summary: 'Invite a new sub-admin with a role or explicit permissions (requires users.create)',
  })
  @ApiOkResponse({ type: InviteResponseDto })
  @NotClientScoped('Creates an admin_invites row. Administrators are not clients.')
  @Audited('admin.invite')
  invite(@Body() dto: InviteDto, @Req() req: Request & { admin: Admin }) {
    return this.auth.createInvite(dto.email, dto.name, req.admin, dto.roleId, dto.permissions);
  }

  /*
   * Listed under users.VIEW, not users.create.
   *
   * Reading who is outstanding is the same class of act as reading the admin
   * directory — it is the other half of "who can operate this system". Gating it
   * on users.create would mean an operator who can see every administrator
   * cannot see that three more are one click from existing.
   */
  @Get('invites')
  @UseGuards(PermissionsGuard)
  @RequirePermissions('users.view')
  @ApiCookieAuth()
  @ApiOperation({ summary: 'List outstanding invites (requires users.view)' })
  @ApiOkResponse({ type: [PendingInviteDto] })
  @NotClientScoped('Lists admin_invites. Administrators are not clients.')
  listInvites() {
    return this.auth.listPendingInvites();
  }

  @Delete('invites/:id')
  @UseGuards(PermissionsGuard)
  @RequirePermissions('users.create')
  @ApiCookieAuth()
  @ApiOperation({
    summary: 'Revoke an outstanding invite (requires users.create)',
    description:
      'Kills the accept link immediately. Whoever may create an invite may cancel one — ' +
      'the undo for a mistyped address, on a 48-hour credential that creates an admin account.',
  })
  @ApiOkResponse({ type: MessageResponseDto })
  @NotClientScoped('Deletes an admin_invites row. Administrators are not clients.')
  @Audited('admin.invite_revoke')
  revokeInvite(@Param('id', UuidParam) id: string, @Req() req: Request & { admin: Admin }) {
    return this.auth.revokeInvite(id, req.admin);
  }

  @Get('invite/validate')
  // Unauthenticated and returns invitee PII for a valid token — a guessing
  // oracle without a throttle.
  @Throttle({ default: { ttl: 60_000, limit: 10 } })
  @ApiOperation({
    summary: 'Validate invite token — returns email and name for pre-fill',
  })
  @ApiOkResponse({ type: InviteValidationDto })
  @NotClientScoped('Public invite-token check; reads admin_invites only.')
  validateInvite(@Query('token') token: string) {
    return this.auth.validateInviteToken(token);
  }

  @NoCsrf(
    'Establishing a session cannot be a forgery of one: there is nothing yet to ' +
      'protect. Requiring a token here also creates a lockout — an expired or ' +
      'absent token would make it impossible to log in and obtain a fresh one.',
  )
  @Post('invite/accept')
  @Throttle({ default: { ttl: 60_000, limit: 5 } })
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Accept invite and set password — logs admin in immediately',
  })
  @ApiOkResponse({ type: AcceptInviteResponseDto })
  @NotClientScoped('Creates an administrator from an invite; reads no client rows.')
  @Audited('admin.invite_accept')
  acceptInvite(@Body() dto: AcceptInviteDto, @Res({ passthrough: true }) res: Response) {
    return this.auth.acceptInvite(dto.token, dto.password, res);
  }
}
