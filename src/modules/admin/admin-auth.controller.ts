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
  Get,
  HttpCode,
  HttpStatus,
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
  AdminProfileDto,
  InviteResponseDto,
  MessageResponseDto,
} from './dto/responses.dto';
import { AdminGuard, PermissionsGuard, RequirePermissions } from './guards/admin.guard';
import { NoCsrf } from '../../common/security/csrf.guard';

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
  login(@Body() dto: AdminLoginDto, @Res({ passthrough: true }) res: Response) {
    return this.auth.login(dto.email, dto.password, res);
  }

  @NoCsrf(
    'Rotating a session the caller already holds grants no new authority, and a ' +
      'refresh must keep working when the CSRF token has expired alongside the ' +
      'access token — otherwise a returning user is locked out rather than renewed.',
  )
  @Post('auth/refresh')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Admin refresh token' })
  @ApiOkResponse({ type: AdminLoginResponseDto })
  refresh(@Req() req: Request, @Res({ passthrough: true }) res: Response) {
    return this.auth.refresh(req, res);
  }

  @NoCsrf(
    'Ending a session is not an attack worth defending against, and blocking it ' +
      'when the token is missing would leave a user unable to log out — strictly ' +
      'worse for them than the nuisance it prevents.',
  )
  @Post('auth/logout')
  @UseGuards(AdminGuard)
  @HttpCode(HttpStatus.OK)
  @ApiCookieAuth()
  @ApiOperation({ summary: 'Admin logout' })
  @ApiOkResponse({ type: MessageResponseDto })
  logout(@Req() req: Request & { admin: Admin }, @Res({ passthrough: true }) res: Response) {
    return this.auth.logout(req.admin.id, res);
  }

  @Get('auth/me')
  @UseGuards(AdminGuard)
  @ApiCookieAuth()
  @ApiOperation({ summary: 'Get current admin' })
  @ApiOkResponse({ type: AdminProfileDto })
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
  invite(@Body() dto: InviteDto, @Req() req: Request & { admin: Admin }) {
    return this.auth.createInvite(dto.email, dto.name, req.admin, dto.roleId, dto.permissions);
  }

  @Get('invite/validate')
  // Unauthenticated and returns invitee PII for a valid token — a guessing
  // oracle without a throttle.
  @Throttle({ default: { ttl: 60_000, limit: 10 } })
  @ApiOperation({
    summary: 'Validate invite token — returns email and name for pre-fill',
  })
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
  acceptInvite(@Body() dto: AcceptInviteDto, @Res({ passthrough: true }) res: Response) {
    return this.auth.acceptInvite(dto.token, dto.password, res);
  }
}
