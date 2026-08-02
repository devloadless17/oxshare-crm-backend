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
import { ApiTags, ApiOperation, ApiCookieAuth } from '@nestjs/swagger';
import { Request, Response } from 'express';
import { AuthService } from './auth.service';
import { RegisterDto, LoginDto, ResendVerificationDto } from './dto/auth.dto';
import { JwtAuthGuard } from './guards/jwt-auth.guard';
import { User } from '../../store/users.store';

@ApiTags('auth')
@Controller(['auth', 'identity'])
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  @Post('register')
  @ApiOperation({ summary: 'Register a new portal user' })
  register(@Body() dto: RegisterDto) {
    return this.auth.register(dto);
  }

  @Get('verify-email')
  @ApiOperation({ summary: 'Verify email via token from email link' })
  verifyEmail(@Query('token') token: string) {
    return this.auth.verifyEmail(token);
  }

  @Post('resend-verification')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Resend email verification link' })
  resendVerification(@Body() dto: ResendVerificationDto) {
    return this.auth.resendVerification(dto.email);
  }

  @Post('login')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Login — sets httpOnly JWT cookies' })
  login(@Body() dto: LoginDto, @Res({ passthrough: true }) res: Response) {
    return this.auth.login(dto, res);
  }

  @Post('refresh')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Refresh access token using refresh cookie' })
  refresh(@Req() req: Request, @Res({ passthrough: true }) res: Response) {
    const refreshToken = req.cookies?.['refresh_token'];
    const userId = req.cookies?.['user_id'];
    if (!refreshToken || !userId) {
      return { message: 'No refresh token.' };
    }
    return this.auth.refresh(userId, refreshToken, res);
  }

  @Post('logout')
  @UseGuards(JwtAuthGuard)
  @HttpCode(HttpStatus.OK)
  @ApiCookieAuth()
  @ApiOperation({ summary: 'Logout — clears JWT cookies' })
  logout(@Req() req: Request & { user: User }, @Res({ passthrough: true }) res: Response) {
    return this.auth.logout(req.user.id, res);
  }

  @Get('me')
  @UseGuards(JwtAuthGuard)
  @ApiCookieAuth()
  @ApiOperation({ summary: 'Get current authenticated user' })
  me(@Req() req: Request & { user: User }) {
    return this.auth.me(req.user);
  }
}
