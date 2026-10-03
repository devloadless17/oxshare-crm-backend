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
  UseFilters,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { Throttle } from '@nestjs/throttler';
import { KYC_BUCKET, StoredFilesService } from '../../common/uploads/stored-files.service';
import { storedPath } from '../../common/uploads/storage/storage-key';
import { MAX_UPLOAD_BYTES } from './upload-limits';
import { UploadSizeFilter } from './upload-size.filter';
import {
  ApiTags,
  ApiOperation,
  ApiCookieAuth,
  ApiConsumes,
  ApiOkResponse,
  ApiBody,
} from '@nestjs/swagger';
import { memoryStorage } from 'multer';
import { Request } from 'express';
import { KycService } from './kyc.service';
import { JwtAuthGuard } from '../identity/guards/jwt-auth.guard';
import { EmailVerifiedGuard } from '../identity/guards/email-verified.guard';
import { User } from '../../store/users.store';
import { KycConfigStore } from '../../store/kyc-config.store';
import { RejectionReasonsStore } from '../../store/rejection-reasons.store';
import { SaveKycStepDto, UploadKycFileDto } from './dto/kyc.dto';
import { KycStatusDto, KycStepConfigDto } from './dto/kyc-response.dto';

/**
 * Upload hardening — now ENTIRELY in `StoredFilesService`.
 *
 * ## What used to be here, and why none of it is
 *
 * This controller predated `StoredFilesService` and duplicated it: its own
 * allow-list of accepted types, its own extension map, `diskStorage`, and a manual
 * `open`/`read`/`subarray`/`close` dance to sniff a magic-byte header off a file
 * that had ALREADY been written to disk — followed by an `unlink` when the sniff
 * failed.
 *
 * That last part is the shape worth noticing. Every one of those steps existed to
 * clean up after a decision the code could not make until the bytes were on disk.
 * `memoryStorage` removes the problem rather than handling it: the bytes are in a
 * buffer, the type is decided before anything is stored, and a refused upload has
 * nothing to delete.
 *
 * The security properties are unchanged and are asserted in `stored-files.service.ts`:
 * the accepted type is decided from magic bytes and must also agree with the
 * declared one, the stored name is a UUID, and the extension comes from the sniffed
 * type — never from the filename. `payload.html` declared as `image/png` is still
 * refused, which is what stops a stored upload becoming stored XSS on the origin
 * holding the session cookies.
 *
 * ## The size ceiling is still enforced where it stops bytes
 *
 * `MaxFileSizeValidator` is a ParseFilePipe, and a pipe runs AFTER multer has read
 * the whole request body. So multer's own `limits` is what actually stops a
 * multi-gigabyte upload — it aborts the stream mid-flight — and the pipe is the
 * second line that turns the abort into an honest 413. Both read the same constant.
 *
 * With `memoryStorage` that ceiling matters MORE than it did, not less: it is what
 * bounds heap per request. The worst case is `MAX_UPLOAD_BYTES` × concurrent
 * uploads, and per client the 10/min throttle below bounds it further. Anyone
 * raising `MAX_UPLOAD_BYTES` owes that multiplication.
 */

@ApiTags('kyc')
@ApiCookieAuth()
@UseGuards(JwtAuthGuard, EmailVerifiedGuard)
@Controller('kyc')
export class KycController {
  constructor(
    private readonly kyc: KycService,
    private readonly kycConfig: KycConfigStore,
    private readonly files: StoredFilesService,
    /* The reason's Arabic, resolved on read (0179) — `rejectionReasonAr`. */
    private readonly reasons: RejectionReasonsStore,
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
    return this.kyc
      .getStatus(req.user.id)
      .then((view) => this.reasons.withReasonArabic('kyc', view));
  }

  @Post('step')
  @ApiOperation({
    summary: 'Save data for a KYC step (personal/document/selfie/address)',
  })
  @ApiOkResponse({
    type: KycStatusDto,
    description: 'The saved submission with every step state — this step judged as presented.',
  })
  saveStep(@Req() req: Request & { user: User }, @Body() dto: SaveKycStepDto) {
    return this.kyc
      .saveStep(req.user.id, dto.step, dto.data)
      .then((view) => this.reasons.withReasonArabic('kyc', view));
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
        docType: { type: 'string', example: 'national_id' },
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
  // Route-scoped: only an upload's 413 is certainly about a document's size.
  @UseFilters(UploadSizeFilter)
  // `limits` is what actually stops the bytes — see MAX_UPLOAD_BYTES above.
  // `files: 1` matters too: without it a client may post any number of parts
  // under the field name, each one its own 10 MB.
  @UseInterceptors(
    FileInterceptor('file', {
      /*
       * `memoryStorage`, not `diskStorage`, and that is the whole difference.
       *
       * The bytes never touch this host: they are validated in a buffer and
       * streamed to object storage, so a refused upload leaves nothing behind and
       * an accepted one leaves nothing here to lose with the host.
       */
      storage: memoryStorage(),
      /*
       * `limits` is what actually stops the bytes — it aborts the stream
       * mid-flight, before the buffer grows. `files: 1` matters too: without it a
       * client may post any number of parts under the field name, each its own
       * 10MB, and `memoryStorage` would hold all of them.
       *
       * There is deliberately NO `fileFilter`. It ran before any bytes existed and
       * could only read the client's own `Content-Type` header, so it refused
       * honest uploads and admitted dishonest ones. The real check needs the bytes
       * and now happens in `StoredFilesService.write`, once.
       */
      limits: { fileSize: MAX_UPLOAD_BYTES, files: 1 },
    }),
  )
  async uploadFile(
    @Req() req: Request & { user: User },
    @UploadedFile(
      // Kept as the second line of defence. multer rejects oversize bodies before
      // they land, so in practice this fires only if the two numbers ever drift
      // apart — which is why they come from the same constant.
      new ParseFilePipe({
        validators: [new MaxFileSizeValidator({ maxSize: MAX_UPLOAD_BYTES })],
      }),
    )
    file: Express.Multer.File,
    @Body() dto: UploadKycFileDto,
  ) {
    if (!file?.buffer?.length) throw new BadRequestException('No file was uploaded.');

    /*
     * Validation, storage and the registry row, in one call.
     *
     * `write` decides the type from the file's own magic bytes, refuses anything
     * the KYC bucket does not accept (with the message that names the iPhone HEIC
     * fix), enforces the client's storage quota, computes the SHA-256 that R2
     * verifies on write, and records the object in `stored_objects` — so "who
     * uploaded this document and when" is answerable from here on.
     *
     * The owner is the CALLING CLIENT, taken from the session and never from a
     * parameter (R-4.4). A field in the body deciding whose quota is charged and
     * whose documents these are would be the whole distance between "my data" and
     * "anyone's data".
     */
    const stored = await this.files.write(KYC_BUCKET, file.buffer, file.mimetype, {
      id: req.user.id,
      kind: 'client',
      ownerUserId: req.user.id,
    });

    try {
      /*
       * The submission records the same path shape multer used to produce
       * (`uploads/kyc/<uuid>.jpg`), so rows written before and after this change
       * read identically and the frontends' URL builders need no branch. See
       * `storage/storage-key.ts` for why that mirror is load-bearing.
       */
      return await this.kyc.attachFile(
        req.user.id,
        dto.field,
        storedPath(KYC_BUCKET.dir, stored.filename),
        dto.docType,
      );
    } catch (error) {
      // The object is already stored. If recording it against the submission
      // fails, it is referenced by nothing — unservable, unreviewable, and
      // invisible to every screen. Orphaned identity documents are both a cost
      // problem and a data-retention one, so it goes now.
      await this.files.remove(KYC_BUCKET, stored.filename);
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
