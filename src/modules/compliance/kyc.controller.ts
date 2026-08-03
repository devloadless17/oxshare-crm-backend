import {
  Controller,
  Get,
  Post,
  Body,
  UseGuards,
  Req,
  UseInterceptors,
  UploadedFile,
  ParseFilePipe,
  MaxFileSizeValidator,
  BadRequestException,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import {
  ApiTags,
  ApiOperation,
  ApiCookieAuth,
  ApiConsumes,
  ApiOkResponse,
  ApiBody,
} from '@nestjs/swagger';
import { diskStorage } from 'multer';
import { Request } from 'express';
import { randomUUID } from 'crypto';
import { KycService } from './kyc.service';
import { JwtAuthGuard } from '../identity/guards/jwt-auth.guard';
import { EmailVerifiedGuard } from '../identity/guards/email-verified.guard';
import { User } from '../../store/users.store';
import { KycConfigStore } from '../../store/kyc-config.store';
import { SaveKycStepDto, UploadKycFileDto } from './dto/kyc.dto';
import { KycStatusDto, KycStepConfigDto } from './dto/kyc-response.dto';

/**
 * Upload hardening.
 *
 * The stored extension previously came from the client-supplied filename while
 * the type check trusted the client-supplied Content-Type. Uploading
 * `payload.html` declared as `image/png` stored a `.html` file that the uploads
 * controller then served with `Content-Type: text/html` from the API origin —
 * the same origin that holds the session cookies. That is stored XSS into
 * session theft.
 *
 * Now: the extension is derived from an allowlist keyed on the declared type,
 * never from the filename, and the served response is forced to download with
 * nosniff (see uploads.controller.ts).
 */
const ALLOWED_UPLOAD_TYPES: Record<string, string> = {
  'image/jpeg': '.jpg',
  'image/jpg': '.jpg',
  'image/png': '.png',
  'image/webp': '.webp',
  'application/pdf': '.pdf',
};

const multerStorage = diskStorage({
  destination: './uploads/kyc',
  filename: (
    _req: Request,
    file: Express.Multer.File,
    cb: (err: Error | null, name: string) => void,
  ) => {
    const extension = ALLOWED_UPLOAD_TYPES[file.mimetype.toLowerCase()] ?? '.bin';
    // randomUUID, not Date.now()+Math.random(): the old scheme was guessable,
    // and these are filenames for identity documents.
    cb(null, `${randomUUID()}${extension}`);
  },
});

const fileFilter = (
  _req: Request,
  file: Express.Multer.File,
  cb: (error: Error | null, acceptFile: boolean) => void,
) => {
  if (ALLOWED_UPLOAD_TYPES[file.mimetype.toLowerCase()]) {
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
  constructor(
    private readonly kyc: KycService,
    private readonly kycConfig: KycConfigStore,
  ) {}

  @Get('config')
  @ApiOperation({ summary: 'Get active KYC onboarding steps' })
  // A bare array, already filtered to enabled and ordered by stepNumber. An
  // empty result is not a renderable "no config" state — see the DTO note.
  @ApiOkResponse({ type: [KycStepConfigDto] })
  async getConfig() {
    return (await this.kycConfig.getSteps()).filter((s) => s.enabled);
  }

  @Get('status')
  @ApiOperation({ summary: 'Get current user KYC status and submitted data' })
  @ApiOkResponse({ type: KycStatusDto })
  status(@Req() req: Request & { user: User }) {
    return this.kyc.getStatus(req.user.id);
  }

  @Post('step')
  @ApiOperation({
    summary: 'Save data for a KYC step (personal/document/selfie/address)',
  })
  saveStep(@Req() req: Request & { user: User }, @Body() dto: SaveKycStepDto) {
    return this.kyc.saveStep(req.user.id, dto.step, dto.data);
  }

  @Post('upload')
  @ApiOperation({
    summary: 'Upload a KYC file (doc_front, doc_back, selfie, address_proof)',
  })
  @ApiConsumes('multipart/form-data')
  @ApiBody({
    schema: {
      type: 'object',
      required: ['file', 'field'],
      properties: {
        file: { type: 'string', format: 'binary' },
        field: { type: 'string', example: 'doc_front' },
      },
    },
  })
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
    @Body() dto: UploadKycFileDto,
  ) {
    return this.kyc.attachFile(req.user.id, dto.field, file.path, file.originalname);
  }

  @Post('submit')
  @ApiOperation({
    summary: 'Submit KYC for review — all steps must be complete',
  })
  submit(@Req() req: Request & { user: User }) {
    return this.kyc.submit(req.user.id);
  }

  @Post('reset')
  @ApiOperation({ summary: 'Reset KYC submission for current user' })
  reset(@Req() req: Request & { user: User }) {
    return this.kyc.resetKyc(req.user.id);
  }

  // REMOVED: POST /kyc/reset-all. It was reachable by any verified client and
  // deleted every KYC submission plus every uploaded document, system-wide.
  // A destructive maintenance operation does not belong on a client-facing
  // controller; if it is needed again it belongs behind MasterAdminGuard and
  // a non-production check.
}
