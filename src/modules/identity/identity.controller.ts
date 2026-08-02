import { Controller, Post, Body, HttpCode, HttpStatus } from '@nestjs/common';
import { IdentityService } from './identity.service';

@Controller('identity')
export class IdentityController {
  constructor(private readonly identityService: IdentityService) {}

  @Post('register')
  async register(
    @Body() dto: { email: string; password: string; firstName?: string; lastName?: string },
  ) {
    return this.identityService.register(dto);
  }

  @Post('verify-email')
  @HttpCode(HttpStatus.OK)
  async verifyEmail(@Body() dto: { token: string }) {
    return this.identityService.verifyEmail(dto.token);
  }

  @Post('login')
  @HttpCode(HttpStatus.OK)
  async login(
    @Body() dto: { email: string; password: string; role?: 'CLIENT' | 'ADMIN' },
  ) {
    return this.identityService.login(dto);
  }

  @Post('refresh')
  @HttpCode(HttpStatus.OK)
  async refreshToken(@Body() dto: { refreshToken: string }) {
    return this.identityService.refreshToken(dto.refreshToken);
  }

  @Post('forgot-password')
  @HttpCode(HttpStatus.OK)
  async forgotPassword(@Body() dto: { email: string }) {
    return this.identityService.forgotPassword(dto.email);
  }

  @Post('reset-password')
  @HttpCode(HttpStatus.OK)
  async resetPassword(@Body() dto: { token: string; newPassword: string }) {
    return this.identityService.resetPassword(dto);
  }
}
