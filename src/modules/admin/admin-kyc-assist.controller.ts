import {
  BadRequestException,
  Body,
  Controller,
  Get,
  MaxFileSizeValidator,
  Param,
  ParseFilePipe,
  Post,
  Req,
  UploadedFile,
  UseFilters,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { Throttle } from '@nestjs/throttler';
import {
  ApiBody,
  ApiConsumes,
  ApiCookieAuth,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { memoryStorage } from 'multer';
import { Request } from 'express';
import { AdminKycAssistService } from './admin-kyc-assist.service';
import { KycAssistViewDto } from './dto/kyc-assist.dto';
import { AssistReturnDto, AssistSubmitDto } from './dto/requests/compliance.dto';
import { SaveKycStepDto, UploadKycFileDto } from '../compliance/dto/kyc.dto';
import { MAX_UPLOAD_BYTES } from '../compliance/upload-limits';
import { UploadSizeFilter } from '../compliance/upload-size.filter';
import {
  PermissionsGuard,
  RequirePermissions,
  type AuthenticatedAdmin,
} from './guards/admin.guard';
import { ClientRefPipe } from '../../common/client-ref.pipe';
import { ScopedToClients } from './guards/client-scope.decorator';
import { Audited } from './guards/audited.decorator';
import { AnnouncesChange } from '../../common/realtime/announces-change.decorator';

const SCOPED =
  'UsersStore.findForAdmin with the actor scope before anything is read — an out-of-scope ' +
  'client 404s exactly as a missing one does.';

/**
 * "Complete KYC" (0210): staff do a client's KYC for them through the client's
 * own KYC actions and rules — see `AdminKycAssistService`. Every route needs
 * `kyc.assist`; returning and approving also need `kyc.review`, asked in the
 * service because `@RequirePermissions` is any-of.
 */
@ApiTags('admin')
@Controller('admin')
export class AdminKycAssistController {
  constructor(private readonly assist: AdminKycAssistService) {}

  @Get('kyc/:userId/assist')
  @UseGuards(PermissionsGuard)
  @RequirePermissions('kyc.assist')
  @ApiCookieAuth()
  @ApiOperation({
    summary: "A client's KYC laid out for staff to complete it for them",
    description:
      "The broker's form with every step's verdict (what is missing, what was returned) and " +
      'the upload slots of each document page. Answers are in `personalInfo` / `stepData`, ' +
      'masked like the review page. Writes nothing: opening it for a client who never started ' +
      'does not create their KYC.',
  })
  @ApiOkResponse({ type: KycAssistViewDto })
  @ScopedToClients(SCOPED)
  getAssist(
    @Param('userId', ClientRefPipe) userId: number,
    @Req() req: Request & { admin: AuthenticatedAdmin },
  ) {
    return this.assist.view(userId, req.admin, true);
  }

  @Post('kyc/:userId/assist/step')
  @AnnouncesChange('kyc')
  @UseGuards(PermissionsGuard)
  @RequirePermissions('kyc.assist')
  @ApiCookieAuth()
  @ApiOperation({
    summary: "Save answers on a client's KYC step for them",
    description:
      "The client's own `saveStep`: the same checks, refused while the KYC waits for review or " +
      'is approved. A changed identity detail is written to the profile and audited under you.',
  })
  @ApiOkResponse({ type: KycAssistViewDto })
  @ScopedToClients(SCOPED)
  @Audited('kyc.assist_step')
  saveStep(
    @Param('userId', ClientRefPipe) userId: number,
    @Body() dto: SaveKycStepDto,
    @Req() req: Request & { admin: AuthenticatedAdmin },
  ) {
    return this.assist.saveStep(userId, dto, req.admin);
  }

  @Post('kyc/:userId/assist/upload')
  @AnnouncesChange('kyc')
  @UseGuards(PermissionsGuard)
  @RequirePermissions('kyc.assist')
  @ApiCookieAuth()
  @ApiOperation({
    summary: "Upload a page or photo into a client's KYC for them",
    description:
      'Send `field` and `docType` exactly as the page layout gives them (`target`). The same ' +
      "checks as the client's own upload — type from the bytes, 10 MB, the client's allowance — " +
      'and the registry records you as the uploader. Replacing a page keeps the old version in ' +
      "the client's history.",
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
  @ApiOkResponse({ type: KycAssistViewDto })
  // A whole submission is a handful of pages; 30/min leaves room for retakes.
  @Throttle({ default: { ttl: 60_000, limit: 30 } })
  @UseFilters(UploadSizeFilter)
  @UseInterceptors(
    FileInterceptor('file', {
      // Validated in a buffer and streamed to object storage — see kyc.controller.ts.
      storage: memoryStorage(),
      limits: { fileSize: MAX_UPLOAD_BYTES, files: 1 },
    }),
  )
  @ScopedToClients(SCOPED)
  @Audited('kyc.assist_upload')
  upload(
    @Param('userId', ClientRefPipe) userId: number,
    @UploadedFile(
      new ParseFilePipe({ validators: [new MaxFileSizeValidator({ maxSize: MAX_UPLOAD_BYTES })] }),
    )
    file: Express.Multer.File,
    @Body() dto: UploadKycFileDto,
    @Req() req: Request & { admin: AuthenticatedAdmin },
  ) {
    if (!file?.buffer?.length) throw new BadRequestException('No file was uploaded.');
    return this.assist.upload(userId, file, dto, req.admin);
  }

  @Post('kyc/:userId/assist/submit')
  @AnnouncesChange('kyc')
  @UseGuards(PermissionsGuard)
  @RequirePermissions('kyc.assist')
  @ApiCookieAuth()
  @ApiOperation({
    summary: "Submit a client's KYC for them (and approve it, with `approve`)",
    description:
      "The client's own submit and its one judge; the submission records you. With " +
      "`approve: true` (needs `kyc.review`) the review page's approve runs right after, with " +
      'its own checks — refused before anything is submitted when you may not approve.',
  })
  @ApiOkResponse({ type: KycAssistViewDto })
  @ScopedToClients(SCOPED)
  @Audited('kyc.assist_submit')
  submit(
    @Param('userId', ClientRefPipe) userId: number,
    @Body() dto: AssistSubmitDto,
    @Req() req: Request & { admin: AuthenticatedAdmin },
  ) {
    return this.assist.submit(userId, dto, req.admin);
  }

  @Post('kyc/:userId/assist/return')
  @AnnouncesChange('kyc')
  @UseGuards(PermissionsGuard)
  @RequirePermissions('kyc.assist')
  @ApiCookieAuth()
  @ApiOperation({
    summary: 'Return a KYC waiting for review to open, to complete it for the client',
    description:
      'Recorded as a return (needs `kyc.review` too); the client is not emailed, because staff ' +
      'are handling it. Only from submitted or under review — an approved verification goes ' +
      'back through Request re-verification.',
  })
  @ApiOkResponse({ type: KycAssistViewDto })
  @ScopedToClients(SCOPED)
  @Audited('kyc.assist_return')
  returnToEdit(
    @Param('userId', ClientRefPipe) userId: number,
    @Body() dto: AssistReturnDto,
    @Req() req: Request & { admin: AuthenticatedAdmin },
  ) {
    return this.assist.returnToEdit(userId, dto, req.admin);
  }
}
