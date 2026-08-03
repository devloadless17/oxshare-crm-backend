import {
  Controller,
  Post,
  Get,
  Body,
  Query,
  Req,
  Res,
  UseGuards,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import {
  ApiTags,
  ApiOperation,
  ApiCookieAuth,
  ApiOkResponse,
  ApiCreatedResponse,
} from '@nestjs/swagger';
import { Request, Response } from 'express';
import { Throttle } from '@nestjs/throttler';
import { AuthService } from './auth.service';
import { AuthTokensResponseDto, MessageResponseDto, UserProfileDto } from './dto/auth-response.dto';
import { RegisterDto, LoginDto, ResendVerificationDto } from './dto/auth.dto';
import { JwtAuthGuard } from './guards/jwt-auth.guard';
import { User } from '../../store/users.store';

@ApiTags('auth')
@Controller(['auth', 'identity'])
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  @Post('register')
  @Throttle({ default: { ttl: 3_600_000, limit: 10 } })
  @ApiOperation({ summary: 'Register a new portal user' })
  @ApiCreatedResponse({ type: AuthTokensResponseDto })
  register(@Body() dto: RegisterDto) {
    return this.auth.register(dto);
  }

  @Get('verify-email')
  @ApiOperation({ summary: 'Verify email via token from email link' })
  @ApiOkResponse({ type: MessageResponseDto })
  verifyEmail(@Query('token') token: string) {
    return this.auth.verifyEmail(token);
  }

  @Post('resend-verification')
  // §8.4's pattern: a mail-bomb vector without a per-user limit.
  @Throttle({ default: { ttl: 900_000, limit: 3 } })
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Resend email verification link' })
  @ApiOkResponse({ type: MessageResponseDto })
  resendVerification(@Body() dto: ResendVerificationDto) {
    return this.auth.resendVerification(dto.email);
  }

  @Post('login')
  @Throttle({ default: { ttl: 60_000, limit: 5 } })
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Login — also sets the JWT cookies (deliberately readable by JS, not httpOnly)',
  })
  @ApiOkResponse({ type: AuthTokensResponseDto })
  login(@Body() dto: LoginDto, @Res({ passthrough: true }) res: Response) {
    return this.auth.login(dto, res);
  }

  @Post('refresh')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Refresh access token' })
  @ApiOkResponse({ type: AuthTokensResponseDto })
  refresh(
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
    @Body('refreshToken') bodyToken?: string,
  ) {
    const headerToken = req.headers.authorization?.replace('Bearer ', '');
    const refreshToken = req.cookies?.['refresh_token'] || bodyToken || headerToken;
    return this.auth.refreshFromToken(refreshToken, res);
  }

  @Post('logout')
  @UseGuards(JwtAuthGuard)
  @HttpCode(HttpStatus.OK)
  @ApiCookieAuth()
  @ApiOperation({ summary: 'Logout — clears JWT cookies' })
  @ApiOkResponse({ type: MessageResponseDto })
  logout(@Req() req: Request & { user: User }, @Res({ passthrough: true }) res: Response) {
    return this.auth.logout(req.user.id, res);
  }

  @Get('me')
  @UseGuards(JwtAuthGuard)
  @ApiCookieAuth()
  @ApiOperation({ summary: 'Get current authenticated user' })
  // The portal's UserContext hand-wrote this shape because it had nothing to
  // alias, and its copy drifted: it declared `role` and `isEmailVerified`,
  // neither of which sanitize() returns.
  @ApiOkResponse({ type: UserProfileDto })
  me(@Req() req: Request & { user: User }) {
    return this.auth.me(req.user);
  }
}
