import {
  Controller, Get, Post, Patch, Body, Param, Query,
  UseGuards, Req, UseInterceptors, UploadedFile,
  ParseFilePipe, MaxFileSizeValidator, BadRequestException,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ApiTags, ApiOperation, ApiCookieAuth, ApiConsumes } from '@nestjs/swagger';
import { diskStorage } from 'multer';
import { Request } from 'express';
import { extname } from 'path';
import { KycService } from './kyc.service';
import { JwtAuthGuard } from '../identity/guards/jwt-auth.guard';
import { EmailVerifiedGuard } from '../identity/guards/email-verified.guard';
import { User } from '../../store/users.store';
import { KycConfigStore } from '../../store/kyc-config.store';

const multerStorage = diskStorage({
  destination: './uploads/kyc',
  filename: (_req: Request, file: { originalname: string }, cb: (err: Error | null, name: string) => void) => {
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1e9);
    cb(null, `${uniqueSuffix}${extname(file.originalname)}`);
  },
});

const fileFilter = (
  _req: Request,
  file: Express.Multer.File,
  cb: (error: Error | null, acceptFile: boolean) => void,
) => {
  if (file.mimetype.match(/^image\/(jpeg|png|webp|jpg)$/i) || file.mimetype === 'application/pdf') {
    cb(null, true);
  } else {
    cb(new BadRequestException('Only JPG, PNG, WEBP images and PDF files are allowed.'), false);
  }
};

@ApiTags('kyc')
@ApiCookieAuth()
@UseGuards(JwtAuthGuard, EmailVerifiedGuard)
@Controller('kyc')
export class KycController {
  constructor(private readonly kyc: KycService) {}

  @Get('config')
  @ApiOperation({ summary: 'Get active KYC onboarding steps' })
  getConfig() {
    return KycConfigStore.getSteps().filter((s) => s.enabled);
  }

  @Get('status')
  @ApiOperation({ summary: 'Get current user KYC status and submitted data' })
  status(@Req() req: Request & { user: User }) {
    return this.kyc.getStatus(req.user.id);
  }

  @Post('step')
  @ApiOperation({ summary: 'Save data for a KYC step (personal/document/selfie/address)' })
  saveStep(
    @Req() req: Request & { user: User },
    @Body() body: { step: string; data: Record<string, unknown> },
  ) {
    return this.kyc.saveStep(req.user.id, body.step, body.data);
  }

  @Post('upload')
  @ApiOperation({ summary: 'Upload a KYC file (doc_front, doc_back, selfie, address_proof)' })
  @ApiConsumes('multipart/form-data')
  @UseInterceptors(FileInterceptor('file', { storage: multerStorage, fileFilter }))
  uploadFile(
    @Req() req: Request & { user: User },
    @UploadedFile(
      new ParseFilePipe({
        validators: [
          new MaxFileSizeValidator({ maxSize: 10 * 1024 * 1024 }), // 10MB
        ],
      }),
    )
    file: Express.Multer.File & { path: string; originalname: string },
    @Body('field') field: string,
  ) {
    return this.kyc.attachFile(req.user.id, field, file.path, file.originalname);
  }

  @Post('submit')
  @ApiOperation({ summary: 'Submit KYC for review — all steps must be complete' })
  submit(@Req() req: Request & { user: User }) {
    return this.kyc.submit(req.user.id);
  }

  @Post('reset')
  @ApiOperation({ summary: 'Reset KYC submission for current user' })
  reset(@Req() req: Request & { user: User }) {
    return this.kyc.resetKyc(req.user.id);
  }

  @Post('reset-all')
  @ApiOperation({ summary: 'Reset all KYC submissions and clear uploaded files' })
  resetAll() {
    return this.kyc.resetAllKyc();
  }
}
