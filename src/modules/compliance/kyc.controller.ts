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
import { unlink } from 'fs/promises';
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

/**
 * The size ceiling, declared once and enforced where it actually stops bytes.
 *
 * `MaxFileSizeValidator` is a ParseFilePipe, and a pipe runs AFTER multer has
 * already streamed the whole request body to disk. So the 10 MB limit this file
 * advertised was real for the response and useless for the disk: an
 * authenticated client could post a multi-gigabyte body, have every byte written
 * under ./uploads/kyc, and only then receive a 413.
 *
 * That matters more here than it would elsewhere. KYC documents live on the API
 * host's LOCAL DISK (ARCHITECTURE §8.5's private-S3 move is still pending), so
 * the same volume holds every identity document the business is required to
 * keep — and nothing throttles this route beyond the global 120/min.
 *
 * multer's own `limits` is the fix: it aborts the stream mid-flight, so the
 * bytes are never written. The pipe validator stays as the second line, because
 * it is what turns the abort into an honest 413 for the caller.
 */
const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;

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
  // `limits` is what actually stops the bytes — see MAX_UPLOAD_BYTES above.
  // `files: 1` matters too: without it a client may post any number of parts
  // under the field name, each one its own 10 MB.
  @UseInterceptors(
    FileInterceptor('file', {
      storage: multerStorage,
      fileFilter,
      limits: { fileSize: MAX_UPLOAD_BYTES, files: 1 },
    }),
  )
  async uploadFile(
    @Req() req: Request & { user: User },
    @UploadedFile(
      // Kept as the second line of defence. multer now rejects oversize bodies
      // before they land, so in practice this fires only if the two numbers ever
      // drift apart — which is why they now come from the same constant.
      new ParseFilePipe({
        validators: [new MaxFileSizeValidator({ maxSize: MAX_UPLOAD_BYTES })],
      }),
    )
    file: Express.Multer.File & { path: string; originalname: string },
    @Body() dto: UploadKycFileDto,
  ) {
    try {
      return await this.kyc.attachFile(req.user.id, dto.field, file.path, file.originalname);
    } catch (error) {
      // The bytes are already on disk by the time the service runs. If recording
      // them fails, the file is unreferenced by any submission — so it can never
      // be served, never be reviewed, and never be cleaned up by anything else.
      // Orphaned identity documents accumulating on the API host is both a disk
      // problem and a data-retention one.
      await unlink(file.path).catch(() => undefined);
      throw error;
    }
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
