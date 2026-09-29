import { Throttle } from '@nestjs/throttler';
import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  Query,
  Req,
  Res,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { memoryStorage } from 'multer';
import {
  ApiConsumes,
  ApiCookieAuth,
  ApiOkResponse,
  ApiOperation,
  ApiQuery,
  ApiTags,
} from '@nestjs/swagger';
import { ValidationError } from '../../common/errors/domain-errors';
import { PAYMENT_LOGO_BUCKET, StoredFilesService } from '../../common/uploads/stored-files.service';
import { Request, Response } from 'express';
import {
  exportFormat,
  streamCsvFromArray,
  EXPORT_RATE_LIMIT,
} from '../../common/export/export-response';
import { NotAudited } from '../admin/guards/audited.decorator';
import {
  AuthenticatedAdmin,
  PermissionsGuard,
  RequirePermissions,
} from '../admin/guards/admin.guard';
import { NotClientScoped } from '../admin/guards/client-scope.decorator';
import { Audited } from '../admin/guards/audited.decorator';
import { PaymentMethodsService } from './payment-methods.service';
import {
  CreatePaymentMethodDto,
  PaymentLogoResponseDto,
  PaymentMethodDto,
  UpdatePaymentMethodDto,
} from './dto/payment-method.dto';
import { paymentMethodView } from './payment-method-view';

/**
 * How clients can put money in — the operator's side.
 *
 * ## `@NotClientScoped`, and why that is not an oversight
 *
 * Every admin route must declare a client-scope stance and
 * `client-scope-coverage.spec.ts` fails the build on one that declares neither.
 * These are platform configuration: they name no client and return no client
 * data. The deposits made THROUGH a method are client data, and they live on
 * the transactions queue, which is scoped.
 *
 * ## Reads are `payments.view`, writes are `payments.edit`
 *
 * Matching the settings and IB-level splits. A write here changes the account
 * number every client is told to send money to, which is why the two are
 * separate and why every write is audited.
 */
@ApiTags('admin')
@Controller('admin/payment-methods')
export class AdminPaymentMethodsController {
  constructor(
    private readonly methods: PaymentMethodsService,
    private readonly files: StoredFilesService,
  ) {}

  @Get()
  @UseGuards(PermissionsGuard)
  @RequirePermissions('payments.view')
  @ApiCookieAuth()
  @ApiOperation({
    summary: 'Every payment method, enabled or not',
    description:
      'Includes disabled methods — turning them on and off is the point of the screen. Clients ' +
      'see a narrower list: GET /payments/methods returns only what is enabled AND, for a ' +
      'gateway, reachable from this deployment.',
  })
  @ApiOkResponse({ type: PaymentMethodDto, isArray: true })
  @NotClientScoped('Platform payment configuration; names no client and returns no client data.')
  async list() {
    return (await this.methods.listAll()).map(paymentMethodView);
  }

  /**
   * Every payment method as CSV.
   *
   * The per-method bounds, pay-to and instructions columns went in migration
   * 0042 and `kind` in 0043, so none of them is exported — there is nothing left
   * to export. What remains is the method's identity and the one thing an
   * operator decides: whether clients are offered it.
   */
  @Get('export')
  /*
   * A ceiling on a STREAMING read of the whole client base.
   *
   * Every export here is batched over the full filtered set and held open for
   * the length of the download, and none carried anything but the global
   * 120/min — which is sized for a person clicking around a console, not for
   * 120 concurrent full-table CSV streams. The limit is per route per IP, so a
   * desk exporting clients and then withdrawals is unaffected; what it bounds is
   * one caller pulling the same export in a loop.
   *
   * Six a minute: far above any human use of an Export button, far below what
   * it takes to hurt the database.
   */
  @Throttle({ default: { ttl: 60_000, limit: EXPORT_RATE_LIMIT } })
  @UseGuards(PermissionsGuard)
  @RequirePermissions('payments.view')
  @ApiCookieAuth()
  @ApiOperation({ summary: 'Export every payment method as CSV, configured or not' })
  @ApiOkResponse({
    description: 'A CSV file, named `payment-methods-<YYYY-MM-DD>.csv`.',
    content: { 'text/csv': { schema: { type: 'string', format: 'binary' } } },
  })
  @ApiQuery({ name: 'format', required: false, enum: ['csv'] })
  @NotClientScoped('Platform payment configuration; names no client and returns no client data.')
  @NotAudited(
    'Platform configuration naming no client. The exports worth attributing are the ones carrying client PII or ledger movements; recording this one would bury them.',
  )
  async exportPaymentMethods(@Res() res: Response, @Query('format') format?: string) {
    const chosen = exportFormat(format);
    await streamCsvFromArray(
      res,
      'payment-methods',
      chosen,
      PAYMENT_METHOD_EXPORT_COLUMNS,
      async () => this.methods.listAll(),
    );
  }

  @Post()
  @UseGuards(PermissionsGuard)
  @RequirePermissions('payments.create')
  @ApiCookieAuth()
  @ApiOperation({
    summary: 'Add a payment method',
    description:
      'Key, name, currency and an optional logo. `enabled` decides whether clients are offered ' +
      'it, and is the only thing about a method an operator changes afterwards — with one ' +
      'exception they cannot: a GATEWAY method stays hidden on a deployment holding no provider ' +
      'credentials, because a client who picks it would land on an error.',
  })
  @ApiOkResponse({ type: PaymentMethodDto })
  @NotClientScoped('Platform payment configuration; names no client and returns no client data.')
  @Audited('payment_method.create')
  async create(
    @Req() req: Request & { admin: AuthenticatedAdmin },
    @Body() dto: CreatePaymentMethodDto,
  ) {
    return paymentMethodView(await this.methods.create(dto, req.admin));
  }

  @Patch(':key')
  @UseGuards(PermissionsGuard)
  @RequirePermissions('payments.edit')
  @ApiCookieAuth()
  @ApiOperation({
    summary: 'Update a payment method',
    description:
      'PATCH, and `key` itself is not editable: it is the primary key and `transactions.' +
      'method_key` references it, so renaming is a data migration rather than an edit.',
  })
  @ApiOkResponse({ type: PaymentMethodDto })
  @NotClientScoped('Platform payment configuration; names no client and returns no client data.')
  @Audited('payment_method.update')
  async update(
    @Req() req: Request & { admin: AuthenticatedAdmin },
    @Param('key') key: string,
    @Body() dto: UpdatePaymentMethodDto,
  ) {
    return paymentMethodView(await this.methods.update(key, dto, req.admin));
  }

  /**
   * Upload a logo and get back the URL to store on the method.
   *
   * ## Why an upload rather than a URL field
   *
   * The form used to take a URL, which meant every client's deposit screen
   * loaded an image from a host the operator pasted in — a third party that can
   * change the image, log every client that views it, or simply go away and
   * leave a broken mark on the payment screen. Hosting it ourselves removes all
   * three.
   *
   * ## The type is decided from the BYTES
   *
   * `StoredFilesService` sniffs the content and ignores the multipart
   * `Content-Type`, because that header is a claim by the uploader — and an HTML
   * document declared `image/png` is how a stored file becomes stored XSS.
   *
   * ## SVG is accepted, and what that costs
   *
   * Brand marks arrive as SVG, and rasterising one for a 20px table row throws
   * away the reason it was vector. It is also the ONE accepted type with no
   * magic bytes, so its check is a text scan rather than a signature — an HTML
   * document is text too, and `looksLikeSvg` exists to tell them apart.
   *
   * ⚠️ That scan is only half. The other half is `GET /uploads/payment-logos/:file`
   * serving with `X-Content-Type-Options: nosniff` and `Content-Security-Policy:
   * default-src 'none'; sandbox`, so a stored SVG cannot execute even if one
   * gets past. The two are a PAIR: if the CSP goes, SVG must come out of the
   * bucket. `payment-methods-http.spec.ts` asserts both.
   *
   * The size limit is set at BOTH the interceptor and inside the service, so a
   * ceiling stays a ceiling if one of the two is later reconfigured.
   *
   * Returns the URL only — it does NOT write it to the method. The operator is
   * still editing a form they may cancel, and an upload that mutated the row
   * would change what clients see before Save was pressed.
   */
  @Post('logo')
  @UseGuards(PermissionsGuard)
  @RequirePermissions('payments.edit')
  @UseInterceptors(
    FileInterceptor('file', {
      storage: memoryStorage(),
      limits: { fileSize: PAYMENT_LOGO_BUCKET.maxBytes, files: 1 },
    }),
  )
  @HttpCode(HttpStatus.OK)
  @ApiCookieAuth()
  @ApiConsumes('multipart/form-data')
  @ApiOperation({ summary: 'Upload a payment-method logo (JPEG, PNG, WebP or SVG, max 1MB)' })
  @ApiOkResponse({ type: PaymentLogoResponseDto })
  @NotClientScoped('Platform payment configuration; names no client and returns no client data.')
  /*
   * Not audited, because nothing is CHANGED by it.
   *
   * This writes an orphan file and hands back a URL. Until a create or update
   * attaches that URL to a method, no client sees it and no configuration
   * differs — and both of those ARE audited, carrying the logoUrl in their
   * payload. So the change is attributed where it takes effect. Auditing the
   * upload as well would record every abandoned attempt as if it were one.
   */
  @NotAudited(
    'Writes an unreferenced file and returns its URL; changes no configuration and no client sees it. The create/update that attaches the URL is audited and carries it.',
  )
  async uploadLogo(
    @UploadedFile() file: Express.Multer.File | undefined,
    @Req() req: Request & { admin: { id: string } },
  ) {
    if (!file) throw new ValidationError('No file was uploaded.');
    /*
     * A brand mark belongs to nobody, so it has no owner and counts against no
     * quota (`PAYMENT_LOGO_BUCKET.countsTowardOwnerQuota` is false). The uploading
     * administrator is still recorded — this route is deliberately `@NotAudited`
     * because an abandoned upload is not a configuration change, and the registry
     * row is what makes an unreferenced logo traceable to whoever wrote it.
     */
    const stored = await this.files.write(PAYMENT_LOGO_BUCKET, file.buffer, file.mimetype, {
      id: req.admin.id,
      kind: 'admin',
      ownerUserId: null,
    });
    return { logoUrl: `/v1/uploads/payment-logos/${stored.filename}` };
  }

  /*
   * ── THERE IS NO DELETE, DELIBERATELY ──────────────────────────────────────
   *
   * `DELETE /admin/payment-methods/:key` was removed along with its service
   * method, and the capability is not coming back behind a confirmation dialog.
   *
   * A payment method is referenced by every deposit ever filed against it. The
   * old endpoint already refused to delete one with history — which meant the
   * button worked exactly once per method, on the ones nobody had used, and
   * threw a conflict on every method that mattered. That is a control whose
   * successful case is the uninteresting one.
   *
   * DISABLING does what deleting was reached for: it stops the method being
   * offered to clients immediately (`listAvailable` filters on `enabled`, and
   * `assertUsable` refuses it on the write path), while every historical deposit
   * keeps a readable method name instead of pointing at a row that is gone.
   *
   * So the surface is: create, update, and toggle `enabled`. Nothing here can
   * destroy a row that money history depends on.
   */
}

/**
 * The payment-method export's columns.
 *
 * The whole table, which is now small enough to say so: what the method is, and
 * whether clients are offered it. Nothing here is money, so nothing here needs
 * the §6.1 string handling the other exports do.
 */
const PAYMENT_METHOD_EXPORT_COLUMNS = [
  { header: 'Key', value: (r: PaymentMethodExportRow) => r.key },
  { header: 'Name', value: (r: PaymentMethodExportRow) => r.name },
  { header: 'Currency', value: (r: PaymentMethodExportRow) => r.currency },
  { header: 'Enabled', value: (r: PaymentMethodExportRow) => r.enabled },
  { header: 'Sort order', value: (r: PaymentMethodExportRow) => r.sortOrder },
  { header: 'Updated at', value: (r: PaymentMethodExportRow) => r.updatedAt },
] as const;

interface PaymentMethodExportRow {
  key: string;
  name: string;
  currency: string;
  enabled: boolean;
  sortOrder: number;
  updatedAt: Date;
}
