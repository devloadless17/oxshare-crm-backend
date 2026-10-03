import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpStatus,
  PayloadTooLargeException,
} from '@nestjs/common';
import { Response } from 'express';
import { MAX_UPLOAD_BYTES } from './upload-limits';
import { localizeMessage } from '../../common/i18n/localize-message';
import { requestLocale } from '../../common/i18n/locale';

/**
 * Turn multer's "File too large" into something a client can act on.
 *
 * multer aborts an oversize stream mid-flight, which is what stops the bytes
 * reaching disk — and Nest surfaces that abort as
 * `PayloadTooLargeException('File too large')`. The status is right and the
 * message is useless: it does not say what the limit is, so the only way to
 * find out is to keep trying smaller files.
 *
 * That matters more here than the wording usually would. Most KYC submissions
 * come from phones, a modern phone photo is 3–12 MB, and this is the failure
 * that arrives AFTER the client has spent two minutes uploading over mobile
 * data. "File too large" at the end of that is where people abandon signup.
 *
 * Route-scoped rather than global (see `kyc.controller.ts`): a 413 elsewhere in
 * the API is not necessarily about an uploaded document, and rewriting every
 * one of them from here would be guessing.
 */
@Catch(PayloadTooLargeException)
export class UploadSizeFilter implements ExceptionFilter {
  // The exception itself carries nothing worth relaying — multer's message is
  // the thing being replaced — so it is unused by design.
  catch(_exception: PayloadTooLargeException, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const res = ctx.getResponse<Response>();
    const req = ctx.getRequest<{ id?: string; path: string }>();
    const limitMb = Math.floor(MAX_UPLOAD_BYTES / (1024 * 1024));

    // The same envelope AllExceptionsFilter emits (R-2.2), so a consumer that
    // branches on `code` does not need a special case for this route.
    res.status(HttpStatus.PAYLOAD_TOO_LARGE).json({
      statusCode: HttpStatus.PAYLOAD_TOO_LARGE,
      code: 'PAYLOAD_TOO_LARGE',
      // In the portal's language — this filter answers instead of AllExceptionsFilter.
      message: localizeMessage(
        `That file is larger than the ${limitMb}MB limit. ` +
          'Most phone cameras can be set to a smaller size, or you can retake the photo — a clear ' +
          'photo of the document is usually well under the limit.',
        requestLocale(),
      ),
      requestId: req.id ?? 'unknown',
      timestamp: new Date().toISOString(),
      path: req.path,
    });
  }
}
