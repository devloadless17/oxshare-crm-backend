import {
  Controller, Post, Get, Patch, Put, Delete, Body, Param, Query,
  UseGuards, Req, Res, HttpCode, HttpStatus,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiCookieAuth } from '@nestjs/swagger';
import { Request, Response } from 'express';
import { IsEmail, IsString, MinLength, IsArray, IsOptional } from 'class-validator';
import { AdminService } from './admin.service';
import { AdminGuard, MasterAdminGuard } from './guards/admin.guard';
import { Admin } from '../../store/admins.store';

class AdminLoginDto {
  @IsEmail() email: string;
  @IsString() password: string;
}
class InviteDto {
  @IsEmail() email: string;
  @IsString() name: string;
}
class AcceptInviteDto {
  @IsString() token: string;
  @IsString() @MinLength(8) password: string;
}
class RejectDto {
  @IsString() reason: string;
  @IsArray() @IsOptional() rejectedFields?: string[];
}

@ApiTags('admin')
@Controller('admin')
export class AdminController {
  constructor(private readonly adminService: AdminService) {}

  // ── Auth ──────────────────────────────────────────────────────────────────
  @Post('auth/login')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Admin login' })
  login(@Body() dto: AdminLoginDto, @Res({ passthrough: true }) res: Response) {
    return this.adminService.login(dto.email, dto.password, res);
  }

  @Post('auth/logout')
  @UseGuards(AdminGuard)
  @HttpCode(HttpStatus.OK)
  @ApiCookieAuth()
  @ApiOperation({ summary: 'Admin logout' })
  logout(@Req() req: Request & { admin: Admin }, @Res({ passthrough: true }) res: Response) {
    return this.adminService.logout(req.admin.id, res);
  }

  @Get('auth/me')
  @UseGuards(AdminGuard)
  @ApiCookieAuth()
  @ApiOperation({ summary: 'Get current admin' })
  me(@Req() req: Request & { admin: Admin }) {
    return this.adminService.me(req.admin);
  }

  // ── Invite ────────────────────────────────────────────────────────────────
  @Post('invite')
  @UseGuards(MasterAdminGuard)
  @ApiCookieAuth()
  @ApiOperation({ summary: 'Invite a new sub-admin (master admin only)' })
  invite(@Body() dto: InviteDto, @Req() req: Request & { admin: Admin }) {
    return this.adminService.createInvite(dto.email, dto.name, req.admin.id);
  }

  @Get('invite/validate')
  @ApiOperation({ summary: 'Validate invite token — returns email and name for pre-fill' })
  validateInvite(@Query('token') token: string) {
    return this.adminService.validateInviteToken(token);
  }

  @Post('invite/accept')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Accept invite and set password — logs admin in immediately' })
  acceptInvite(@Body() dto: AcceptInviteDto, @Res({ passthrough: true }) res: Response) {
    return this.adminService.acceptInvite(dto.token, dto.password, res);
  }

  // ── KYC Review ────────────────────────────────────────────────────────────
  @Get('kyc')
  @UseGuards(AdminGuard)
  @ApiCookieAuth()
  @ApiOperation({ summary: 'List all KYC submissions, optionally filtered by status' })
  listKyc(@Query('status') status?: string) {
    return this.adminService.listKyc(status);
  }

  @Get('kyc/:userId')
  @UseGuards(AdminGuard)
  @ApiCookieAuth()
  @ApiOperation({ summary: 'Get full KYC submission for a user' })
  getKyc(@Param('userId') userId: string) {
    return this.adminService.getKyc(userId);
  }

  @Patch('kyc/:userId/approve')
  @UseGuards(AdminGuard)
  @ApiCookieAuth()
  @ApiOperation({ summary: 'Approve KYC — bumps user verificationLevel to 1' })
  approveKyc(@Param('userId') userId: string, @Req() req: Request & { admin: Admin }) {
    return this.adminService.approveKyc(userId, req.admin.id);
  }

  @Patch('kyc/:userId/reject')
  @UseGuards(AdminGuard)
  @ApiCookieAuth()
  @ApiOperation({ summary: 'Reject KYC with a reason' })
  rejectKyc(
    @Param('userId') userId: string,
    @Body() dto: RejectDto,
    @Req() req: Request & { admin: Admin },
  ) {
    return this.adminService.rejectKyc(userId, req.admin.id, dto.reason, dto.rejectedFields);
  }

  // ── KYC Step Configurator ──────────────────────────────────────────────────
  @Get('kyc-config')
  @UseGuards(AdminGuard)
  @ApiCookieAuth()
  @ApiOperation({ summary: 'Get current KYC onboarding steps configuration' })
  getKycConfig() {
    return this.adminService.getKycConfig();
  }

  @Put('kyc-config')
  @UseGuards(AdminGuard)
  @ApiCookieAuth()
  @ApiOperation({ summary: 'Update entire KYC onboarding steps configuration' })
  updateKycConfig(@Body() steps: any[]) {
    return this.adminService.updateKycConfig(steps);
  }

  @Post('kyc-config/steps')
  @UseGuards(AdminGuard)
  @ApiCookieAuth()
  @ApiOperation({ summary: 'Add a new KYC step' })
  addKycStep(@Body() stepData: any) {
    return this.adminService.addKycStep(stepData);
  }

  @Put('kyc-config/steps/:id')
  @UseGuards(AdminGuard)
  @ApiCookieAuth()
  @ApiOperation({ summary: 'Update a specific KYC step' })
  updateKycStep(@Param('id') id: string, @Body() patch: any) {
    return this.adminService.updateKycStep(id, patch);
  }

  @Delete('kyc-config/steps/:id')
  @UseGuards(AdminGuard)
  @ApiCookieAuth()
  @ApiOperation({ summary: 'Delete a KYC step' })
  deleteKycStep(@Param('id') id: string) {
    return this.adminService.deleteKycStep(id);
  }

  @Post('kyc-config/reset')
  @UseGuards(AdminGuard)
  @ApiCookieAuth()
  @ApiOperation({ summary: 'Reset KYC steps to default' })
  resetKycConfig() {
    return this.adminService.resetKycConfig();
  }
}
