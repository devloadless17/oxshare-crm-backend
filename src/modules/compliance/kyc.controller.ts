import {
  Controller, Get, Post, Patch, Body, Param, Query,
  UseGuards, Req, UseInterceptors, UploadedFile,
  ParseFilePipe, MaxFileSizeValidator, FileTypeValidator,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ApiTags, ApiOperation, ApiCookieAuth, ApiConsumes } from '@nestjs/swagger';
import { diskStorage } from 'multer';
import { extname } from 'path';
import { Request } from 'express';
import { KycService } from './kyc.service';
import { JwtAuthGuard } from '../identity/guards/jwt-auth.guard';
import { EmailVerifiedGuard } from '../identity/guards/email-verified.guard';
import { User } from '../../store/users.store';

const multerStorage = diskStorage({
  destination: './uploads/kyc',
  filename: (_req, file, cb) => {
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1e9);
    cb(null, `${uniqueSuffix}${extname(file.originalname)}`);
  },
});

@ApiTags('kyc')
@ApiCookieAuth()
@UseGuards(JwtAuthGuard, EmailVerifiedGuard)
@Controller({ path: 'kyc', version: '1' })
export class KycController {
  constructor(private readonly kyc: KycService) {}

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
  @UseInterceptors(FileInterceptor('file', { storage: multerStorage }))
  uploadFile(
    @Req() req: Request & { user: User },
    @UploadedFile(
      new ParseFilePipe({
        validators: [
          new MaxFileSizeValidator({ maxSize: 10 * 1024 * 1024 }), // 10MB
          new FileTypeValidator({ fileType: /image\/(jpeg|png|webp)|application\/pdf/ }),
        ],
      }),
    )
    file: Express.Multer.File,
    @Body('field') field: string,
  ) {
    return this.kyc.attachFile(req.user.id, field, file.path, file.originalname);
  }

  @Post('submit')
  @ApiOperation({ summary: 'Submit KYC for review — all steps must be complete' })
  submit(@Req() req: Request & { user: User }) {
    return this.kyc.submit(req.user.id);
  }
}
