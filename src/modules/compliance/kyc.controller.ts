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
import { Throttle } from '@nestjs/throttler';
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
import { open, unlink } from 'fs/promises';
import { SIGNATURE_BYTES, signatureMatchesDeclared } from './file-signature';
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

/*
 * The rejection message names the fix, because most uploads come from a phone.
 *
 * iPhones photograph in HEIC by default, and HEIC is not in the allow-list above
 * — decoding it would mean adding an image codec, which is a decision nobody has
 * taken. So an iPhone client can be refused for doing nothing wrong, and the old
 * message ("Only JPG, PNG, WEBP images and PDF files are allowed") told them
 * only that the thing they were holding was not a photo.
 *
 * The setting that resolves it is three levels into iOS Settings and is not
 * something a client will guess. Naming it turns a dead end into an instruction.
 * This does NOT decide the HEIC question — it makes the current answer usable
 * while that decision is outstanding.
 */
const UNSUPPORTED_TYPE_MESSAGE =
  'Only JPG, PNG, WEBP images and PDF files are allowed. ' +
  'If you are on an iPhone, set Settings → Camera → Formats to "Most Compatible" and retake the ' +
  'photo, or choose it from Photos so it is converted to JPG.';

const fileFilter = (
  _req: Request,
  file: Express.Multer.File,
  cb: (error: Error | null, acceptFile: boolean) => void,
) => {
  if (ALLOWED_UPLOAD_TYPES[file.mimetype.toLowerCase()]) {
    cb(null, true);
  } else {
    cb(new BadRequestException(UNSUPPORTED_TYPE_MESSAGE), false);
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
  /*
   * A per-route ceiling, because the global one is not a limit here.
   *
   * This route inherited only the app-wide 120 requests/minute. Against a 10 MB
   * body that is 1.2 GB per minute, per authenticated client, written to the API
   * host's LOCAL DISK — the same volume holding every identity document the
   * business is required to keep (ARCHITECTURE §8.5's private-S3 move is still
   * pending). There is no quota, no disk-space check, and nothing that removes a
   * file once it is superseded, so the bytes stay. Ten clients fill a 100 GB
   * volume in under nine minutes.
   *
   * The admin auth routes already tighten to 5–20/min; the route that writes
   * megabytes was the loosest in the app.
   *
   * 10/min is generous for the real workload: a complete submission is three or
   * four files, and a client correcting a rejection re-uploads one or two.
   */
  @Throttle({ default: { ttl: 60_000, limit: 10 } })
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
    /*
     * What the bytes ARE, not what the client said they were.
     *
     * `fileFilter` and the stored extension were both decided from
     * `file.mimetype` — the Content-Type the CLIENT wrote into the multipart
     * header. multer cannot do better: a fileFilter runs before any bytes exist.
     * So an authenticated client could upload an HTML document, declare it
     * image/png and have it stored as <uuid>.png in the same directory as every
     * identity document the business is required to keep.
     *
     * `uploads.controller.ts` sends X-Content-Type-Options: nosniff, which is
     * what stops a reviewing admin's browser executing it. That single header
     * being the whole defence is the reason to add this one: it is easy to lose
     * in a proxy config, and the account it protects is the one that can read
     * every client's documents.
     *
     * Checked here rather than in the filter because this is the first point at
     * which the bytes exist. Rejection unlinks, using the same path as the
     * failure below — an unreferenced identity document on disk is both a disk
     * problem and a retention one.
     */
    const handle = await open(file.path, 'r');
    let header: Buffer;
    try {
      const buffer = Buffer.alloc(SIGNATURE_BYTES);
      const { bytesRead } = await handle.read(buffer, 0, SIGNATURE_BYTES, 0);
      header = buffer.subarray(0, bytesRead);
    } finally {
      await handle.close();
    }

    if (!signatureMatchesDeclared(header, file.mimetype)) {
      await unlink(file.path).catch(() => undefined);
      // Same guidance as the filter's: a HEIC relabelled `image/jpeg` by the
      // browser passes the filter and fails HERE, and "the content does not
      // match its declared type" is meaningless to someone who just took a
      // photo.
      throw new BadRequestException(
        `The file content does not match its declared type. ${UNSUPPORTED_TYPE_MESSAGE}`,
      );
    }

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
