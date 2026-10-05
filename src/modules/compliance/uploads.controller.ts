import {
  Controller,
  ForbiddenException,
  Get,
  Logger,
  NotFoundException,
  Param,
  Req,
  Res,
  ServiceUnavailableException,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import {
  NotClientScoped,
  ScopedToClients,
} from '../../modules/admin/guards/client-scope.decorator';
import { ApiCookieAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { Request, Response } from 'express';
import { basename } from 'path';
import { EmailVerifiedGuard } from '../identity/guards/email-verified.guard';
import { EmailNotVerifiedError } from '../../common/errors/domain-errors';
import { AdminsStore } from '../../store/admins.store';
import { UsersStore } from '../../store/users.store';
import { AuditLogStore } from '../../store/audit-log.store';
import { COOKIE_BASES, readSessionCookie } from '../../common/security/session-cookies';
import { SessionEndedException } from '../../common/security/session-ended';
import { normalizePermissionKey } from '../../common/security/actor';
import { JwtAuthGuard } from '../identity/guards/jwt-auth.guard';
import { JwtStrategy } from '../identity/strategies/jwt.strategy';
import {
  AdminAuthenticator,
  AdminGuard,
  AnyAdmin,
  type AuthenticatedAdmin,
} from '../admin/guards/admin.guard';
import { IpAllowlistGuard } from '../admin/guards/ip-allowlist.guard';
import {
  AVATAR_BUCKET,
  PAYMENT_LOGO_BUCKET,
  StoredFilesService,
} from '../../common/uploads/stored-files.service';
import type { FileReadPolicy } from '../../common/uploads/file-read-policy';
import { inlineDisposition, streamObject } from '../../common/uploads/stream-object';
import { KycDocumentAccess } from './kyc-document-access.service';
import { DepositReceiptAccess } from '../payments/deposit-receipt-access.service';

/** Who a request resolved to, and therefore what gets recorded about the read. */
type Reader =
  { kind: 'admin'; id: string; email: string } | { kind: 'client'; id: number; email: string };

/*
 * ITS OWN READ BUDGET — 600 a minute, not the global 120.
 *
 * A review page is several document tiles, served `no-store`, so every render
 * fetches each again; a reviewer moving through the queue, on top of the
 * console's own requests, crossed 120 within the minute. The images past it
 * answered 429 and each tile read "Could not load document" (reported from
 * local testing, 30 Sep 2026). Every read here still needs a session and
 * passes the owner and scope checks; the limit bounds a leaked session, it is
 * not the control.
 */
@ApiTags('compliance')
@Throttle({ default: { ttl: 60_000, limit: 600 } })
@Controller('uploads')
export class UploadsController {
  private readonly logger = new Logger(UploadsController.name);

  constructor(
    /*
     * The two-audience routes authenticate through the SAME objects the guards
     * use — never a copy. Each copy of a session pipeline has historically been
     * the one missing a check (suspension, a revoked family, the password
     * cutoff, RBAC-08), and here it guarded every client's passport.
     */
    private readonly adminAuth: AdminAuthenticator,
    private readonly adminNetwork: IpAllowlistGuard,
    private readonly portalAuth: JwtStrategy,
    private readonly kycDocuments: KycDocumentAccess,
    private readonly depositReceipts: DepositReceiptAccess,
    private readonly admins: AdminsStore,
    private readonly users: UsersStore,
    private readonly auditLog: AuditLogStore,
    private readonly files: StoredFilesService,
  ) {}

  /**
   * Serve a profile photo to the client it belongs to.
   *
   * Deliberately NOT public, even though an avatar is far less sensitive than a
   * passport scan. The filename is a UUID, so an unauthenticated route would be
   * "secure" only by being unguessable — and unguessable URLs leak through
   * Referer headers, proxy logs and shared screenshots. There is no requirement
   * anywhere for one client to see another's photo, so nothing is lost by
   * requiring the session that already exists.
   *
   * OWNERSHIP is checked against the row rather than the filename: the caller
   * gets their own `avatar_filename` and it must equal what they asked for.
   * That is what makes a valid session unable to enumerate other people's
   * photos by trying UUIDs.
   *
   * The security headers match the KYC path for the same reason: this origin
   * holds the session cookies, so nothing served from it may ever be
   * interpreted as active content.
   */
  /*
   * `EmailVerifiedGuard` here and NOT on `serveKycFile` below, which is a
   * deliberate split rather than an omission.
   *
   * This route has exactly one reader: the calling CLIENT, fetching their own
   * photo. That is the portal surface, where an unverified address means the
   * account holder is unconfirmed, so it takes the same guard as wallet, KYC,
   * IB and payments.
   *
   * `serveKycFile` serves two different readers — the owning client OR an admin
   * holding `kyc.review` — and resolves that itself in `authorize()`. A
   * controller-level guard there would test `emailVerified` on an ADMIN, who
   * has no such column, and lock reviewers out of every document.
   */
  @Get('avatars/:file')
  @UseGuards(JwtAuthGuard, EmailVerifiedGuard)
  @ApiCookieAuth()
  @ApiOperation({ summary: "Serve a client's own profile photo" })
  @NotClientScoped(
    'Serves the CALLING CLIENT their own photo — an ownership check on the portal surface, with no admin reader at all.',
  )
  async serveAvatar(
    @Param('file') file: string,
    @Req() req: Request & { user: { id: number } },
    @Res() res: Response,
  ) {
    const name = basename(file); // neutralise any traversal attempt

    const owner = await this.users.findById(req.user.id);
    if (!owner || owner.avatarFilename !== name) {
      // 404, not 403: telling a caller "that photo exists but is not yours"
      // confirms the existence of another account's file.
      throw new NotFoundException('Photo not found.');
    }

    /*
     * Declared, for the reason the payment-logo handler below sets out at
     * length: this route sent no `Content-Type` either. It renders anyway
     * because the avatar bucket takes only JPEG, PNG and WebP, all of which a
     * browser decodes from their magic bytes despite `nosniff` — so this is a
     * correctness fix rather than a visible one, and it is what stops the same
     * bug reappearing if a signature-less type is ever added to the bucket.
     */
    const contentType = this.files.contentType(AVATAR_BUCKET, name);
    if (!contentType) throw new NotFoundException('Photo not found.');

    // Conditional and partial reads forwarded from the browser's own headers. An
    // avatar is cacheable (unlike a KYC document), so a revalidation can end as a
    // 304 and move no bytes at all.
    const found = await this.files.read(AVATAR_BUCKET, name, {
      ifNoneMatch: req.headers['if-none-match'],
      range: req.headers.range,
    });
    if (!found) throw new NotFoundException('Photo not found.');

    streamObject(res, found, {
      contentType,
      // Private, because it is one client's photo, and short — an avatar the
      // client has just replaced should not survive on their own screen.
      cacheControl: 'private, max-age=300',
      contentSecurityPolicy: "default-src 'none'; sandbox",
    });
  }

  /**
   * Serve a profile photo to the ADMINISTRATOR it belongs to.
   *
   * ## Why this is a second route and not a branch in the one above
   *
   * `serveAvatar` is guarded by `JwtAuthGuard` + `EmailVerifiedGuard`, which are
   * portal guards: they verify a CLIENT access token and read a column
   * (`emailVerified`) that administrators do not have. An admin cookie fails at
   * the first and would fail at the second, so there was no photo an admin could
   * ever fetch — including their own, which is the only one this route serves.
   *
   * Widening that handler instead would mean dropping both guards and resolving
   * the subject by hand inside it, which is exactly the shape `serveKycFile`
   * below has and the shape its own comment explains is only worth paying for
   * when a file genuinely has TWO readers. This one has exactly one.
   *
   * The bytes share the client bucket — same directory, same 2MB ceiling, same
   * magic-byte check — because they are the same kind of object. Only the door
   * differs, and the ownership check behind it is against `admins`, not `users`.
   */
  @Get('admin-avatars/:file')
  @UseGuards(AdminGuard)
  /*
   * Authenticated is the whole requirement, and it has to SAY so.
   *
   * This route serves an administrator their own photo and nothing else — the
   * ownership check below refuses any other file with a 404 — so no permission
   * key is right for it. That made it the one admin-guarded route in the
   * codebase declaring neither `@RequirePermissions` nor `@AnyAdmin`, which
   * looks identical to a route that forgot.
   *
   * It escaped the census that exists to catch exactly that: `AdminGuard` does
   * not read `PERMISSIONS_KEY`, so deny-by-default never fires, and
   * `route-authorization.spec.ts` filtered on a `/admin` path prefix while this
   * signature reads `/uploads`. That filter is now "guarded by an admin guard",
   * which is the question it was always trying to ask.
   */
  @AnyAdmin(
    'Serves the CALLING administrator their own profile photo. The ownership check in the ' +
      'handler is the authorization; no permission distinguishes one admin from another here.',
  )
  @ApiCookieAuth()
  @ApiOperation({ summary: "Serve an administrator's own profile photo" })
  @NotClientScoped(
    'Serves the CALLING ADMINISTRATOR their own photo. Reads the admins table and no client rows.',
  )
  async serveAdminAvatar(
    @Param('file') file: string,
    @Req() req: Request & { admin: { id: string } },
    @Res() res: Response,
  ) {
    const name = basename(file); // neutralise any traversal attempt

    const owner = await this.admins.findById(req.admin.id);
    if (!owner || owner.avatarFilename !== name) {
      // 404, not 403, for the reason the client route gives: "that photo exists
      // but is not yours" confirms the existence of another account's file.
      throw new NotFoundException('Photo not found.');
    }

    const contentType = this.files.contentType(AVATAR_BUCKET, name);
    if (!contentType) throw new NotFoundException('Photo not found.');

    const found = await this.files.read(AVATAR_BUCKET, name, {
      ifNoneMatch: req.headers['if-none-match'],
      range: req.headers.range,
    });
    if (!found) throw new NotFoundException('Photo not found.');

    streamObject(res, found, {
      contentType,
      // Private and short, matching the client route: a photo just replaced must
      // not survive on the replacer's own screen.
      cacheControl: 'private, max-age=300',
      contentSecurityPolicy: "default-src 'none'; sandbox",
    });
  }

  /**
   * A payment-method logo — PUBLIC, unlike everything else in this controller.
   *
   * ## Why there is no guard here
   *
   * It is a brand mark: the Whish logo, a bank's wordmark. It names no client,
   * reveals nothing about anybody's account, and appears on a deposit screen
   * every client sees. Guarding it would mean a client's payment options fail to
   * render while their session refreshes, for a file whose contents are on the
   * provider's own public website.
   *
   * The other routes here serve a PERSON's photo and their identity documents,
   * which is why those are gated and this is not. That difference is the reason
   * this is a separate handler rather than a parameter on one of them.
   *
   * ## Still served defensively
   *
   * `basename` neutralises traversal, and `sandbox` plus a `script-src` that
   * falls back to `'none'` means nothing reachable here can execute. Cached
   * PUBLICLY for a day: these change roughly never and every client loads them.
   *
   * ## ⚠️ THE BUCKET DOES ACCEPT SVG, and this note used to claim it did not
   *
   * That was true when written and stopped being true when brand marks were
   * allowed in. Two things follow from it, and both were wrong until an uploaded
   * logo failed to appear on the deposit screen:
   *
   *   1. `Content-Type` MUST be sent. It was not sent at all, and `nosniff`
   *      forbids the browser from working one out. A PNG survives that on its
   *      magic bytes, which is why nothing looked broken; SVG is XML with no
   *      signature, so an undeclared one is not rendered as an image at all.
   *   2. The CSP must permit the SVG's OWN stylesheet. Illustrator and Figma
   *      export a `<style>` block and put every fill in it, so `default-src
   *      'none'` — under which `style-src` falls back to `'none'` — stripped the
   *      colour out of any mark that did render.
   *
   * `style-src 'unsafe-inline'` is the narrowest fix and weakens nothing that
   * matters. `script-src` still falls back to `default-src 'none'`, `sandbox`
   * (with no `allow-scripts`) blocks execution independently of it, and CSS
   * `url()` fetches are refused because `img-src`, `font-src` and `connect-src`
   * all still fall back to `'none'`. The stylesheet may colour its own shapes
   * and reach nothing outside itself.
   *
   * These headers are a PAIR with the upload check: `StoredFilesService` refuses
   * anything whose BYTES are not really an image, because an HTML document
   * declared `image/svg+xml` is how a stored file becomes stored XSS. If either
   * side is relaxed, SVG comes out of the bucket.
   * `payment-methods-http.spec.ts` asserts both halves.
   */
  @Get('payment-logos/:file')
  @ApiOperation({ summary: 'Serve a payment-method logo (public)' })
  @NotClientScoped(
    'A payment brand mark on the deposit screen. Names no client and carries no client data.',
  )
  async servePaymentLogo(@Param('file') file: string, @Req() req: Request, @Res() res: Response) {
    const name = basename(file);

    /*
     * From the STORED extension, which this service chose from the file's own
     * magic bytes at upload — never from anything a caller supplied. A file in
     * the bucket with an extension we never write is not one we wrote: 404
     * rather than a guess, because guessing is the sniffing `nosniff` forbids.
     */
    const contentType = this.files.contentType(PAYMENT_LOGO_BUCKET, name);
    if (!contentType) throw new NotFoundException('Logo not found.');

    // These are the most cacheable objects in the system and every client loads
    // them, so a revalidation ending in 304 is the common case worth serving well.
    const found = await this.files.read(PAYMENT_LOGO_BUCKET, name, {
      ifNoneMatch: req.headers['if-none-match'],
      range: req.headers.range,
    });
    if (!found) throw new NotFoundException('Logo not found.');

    streamObject(res, found, {
      contentType,
      cacheControl: 'public, max-age=86400',
      contentSecurityPolicy: "default-src 'none'; style-src 'unsafe-inline'; sandbox",
    });
  }

  /**
   * Serve a deposit RECEIPT to the client who filed it or to a deposit reviewer.
   *
   * No `@UseGuards`: this route serves TWO principals, and which one is acting
   * is only knowable after the token resolves. `authorize` resolves it through
   * the guards' own authenticators — including the RBAC-08 allowlist, which the
   * global `IpAllowlistGuard` never applies here because `/uploads` is outside
   * `/admin`, and a receipt names a bank account.
   */
  @Get('deposit-proofs/:file')
  @ApiCookieAuth()
  @ApiOperation({
    summary: 'Serve a deposit receipt to its owner or a deposits reviewer',
  })
  @ScopedToClients(
    "The filename is resolved to its deposit and that deposit's owner in one scoped query; a miss is 404 and writes no audit row.",
  )
  async serveDepositProof(@Param('file') file: string, @Req() req: Request, @Res() res: Response) {
    return this.serveProtected(req, res, file, this.depositReceipts);
  }

  @Get('kyc/:file')
  @ApiCookieAuth()
  @ApiOperation({
    summary: 'Serve a KYC document to its owner or a kyc.review admin',
  })
  @ScopedToClients(
    'The filename is resolved to its owning user_id in one scoped query; a miss is 404 and writes no audit row.',
  )
  async serveKycFile(@Param('file') file: string, @Req() req: Request, @Res() res: Response) {
    return this.serveProtected(req, res, file, this.kycDocuments);
  }

  /**
   * One protected read: authorize, find, AUDIT, stream.
   *
   * The type comes from the STORED extension, which records what the magic
   * bytes were at upload; an unrecognised extension is a 404 rather than a
   * guess — guessing is the sniffing `nosniff` forbids.
   *
   * `Range` is forwarded (a PDF viewer paints the first page without the whole
   * scan); `If-None-Match` deliberately is NOT: the response is `no-store`, so
   * offering a revalidation path would invite exactly the cached copy that
   * header exists to prevent.
   *
   * The R-6.6 record is written BEFORE any byte and awaited — a failure to
   * record is a failure to serve — and after the object is known to exist, so
   * a read of a missing file writes no row claiming it was viewed. A client
   * reading their own file is recorded too: same PII.
   */
  private async serveProtected(
    req: Request,
    res: Response,
    file: string,
    policy: FileReadPolicy,
  ): Promise<void> {
    const name = basename(file); // neutralize any traversal attempt
    const reader = await this.authorize(req, name, policy);

    const contentType = this.files.contentType(policy.bucket, name);
    if (!contentType) throw new NotFoundException(policy.notFound);

    const found = await this.files.read(policy.bucket, name, { range: req.headers.range });
    if (!found) throw new NotFoundException(policy.notFound);

    await this.recordRead(reader, name, policy);

    streamObject(res, found, {
      contentType,
      /*
       * Never let an identity document or a bank receipt settle into a disk
       * cache: the reviewer's browser opens every client's in a working day,
       * and a heuristic freshness would leave them in a directory that outlives
       * the session and that nothing here can clear.
       */
      cacheControl: 'no-store, private',
      // Never interpreted as active content on this origin — it holds the
      // session cookies.
      contentSecurityPolicy: "default-src 'none'; sandbox",
      contentDisposition: inlineDisposition(name),
    });
  }

  /**
   * Append one row per document read.
   *
   * The filename is the subject: a random UUID chosen by this system that
   * carries nothing about the person. ONE action name for both principals;
   * `actor_kind` says who was acting.
   */
  private async recordRead(
    reader: Reader,
    fileName: string,
    policy: FileReadPolicy,
  ): Promise<void> {
    try {
      await this.auditLog.record({
        actorId: reader.id,
        actorEmail: reader.email,
        actorKind: reader.kind,
        action: policy.audit.action,
        subjectType: policy.audit.subjectType,
        subjectId: fileName,
      });
    } catch (error) {
      // Loud, and then fatal to the request. Serving PII that no record exists
      // for is the exact state this rule is meant to make impossible.
      this.logger.error(
        `Refusing to serve ${fileName}: the PII access record could not be written — ` +
          `${error instanceof Error ? error.message : String(error)}`,
      );
      throw new ServiceUnavailableException(
        'Document access cannot be recorded right now, so it cannot be served. Please retry.',
      );
    }
  }

  /**
   * Authorize the read AND identify the reader — routing only.
   *
   * WHO is asking is answered by the guards' own authenticators
   * (`AdminAuthenticator.authenticateSession`, `JwtStrategy.authenticateToken`),
   * so cookies, token kind, suspension, a revoked family, the password cutoff
   * and the permission load are identical to every other request by
   * construction. WHAT they may read is the bucket's `FileReadPolicy`.
   *
   * An admin cookie that is not a live admin session falls through to the
   * portal branch; a session that was ENDED (`SessionEndedException`) is an
   * answer and propagates, as does every refusal reached on purpose.
   */
  private async authorize(req: Request, fileName: string, policy: FileReadPolicy): Promise<Reader> {
    const cookies = req.cookies as Record<string, string | undefined> | undefined;

    if (readSessionCookie(cookies, COOKIE_BASES.adminAccess)) {
      let admin: AuthenticatedAdmin | undefined;
      try {
        admin = await this.adminAuth.authenticateSession(req);
      } catch (e) {
        if (e instanceof SessionEndedException) throw e;
        // not an admin session after all — fall through to the client branch
      }
      if (admin) return this.authorizeAdmin(req, admin, fileName, policy);
    }

    const clientToken = readSessionCookie(cookies, COOKIE_BASES.clientAccess);
    if (clientToken) {
      let owner: Awaited<ReturnType<JwtStrategy['authenticateToken']>> | undefined;
      try {
        owner = await this.portalAuth.authenticateToken(clientToken);
      } catch (e) {
        if (e instanceof SessionEndedException) throw e;
      }
      if (owner) {
        if (!(await policy.clientOwns(owner.id, fileName))) {
          throw new ForbiddenException(policy.clientForbidden);
        }
        /*
         * `emailVerified` on the CLIENT branch only — an admin has no such
         * column. Checked here rather than by a controller guard because which
         * principal is acting is only knowable after the token resolves.
         */
        if (!owner.emailVerified) {
          throw new EmailNotVerifiedError(
            'Please verify your email address before accessing your documents.',
          );
        }
        return { kind: 'client', id: owner.id, email: owner.email };
      }
    }

    throw new UnauthorizedException('Authentication required to access documents.');
  }

  /**
   * RBAC-08, then the permission, then territory — in that order.
   *
   * The network check applies HERE because `/uploads` is outside `/admin`, so
   * the global `IpAllowlistGuard` never sees this route; it is the guard's own
   * `assertAdmitted`, so the two cannot disagree. Before the permission check:
   * being on a permitted network is a precondition for exercising admin
   * authority at all. Territory is checked before any byte and before the
   * audit row, so a refused read leaves no trace claiming it happened, and is
   * a 404 worded like a missing file.
   */
  private async authorizeAdmin(
    req: Request,
    admin: AuthenticatedAdmin,
    fileName: string,
    policy: FileReadPolicy,
  ): Promise<Reader> {
    // The admin is a SESSION here (`authenticateSession`, never a key), so an
    // exempt administrator (0192) is admitted from any network, as on `/admin`.
    await this.adminNetwork.assertAdmitted(req, admin.id);
    if (!policy.mayRead(admin.permissions.map(normalizePermissionKey))) {
      throw new ForbiddenException(policy.adminForbidden);
    }
    if (!(await policy.inScope(admin.clientScope, fileName))) {
      throw new NotFoundException(policy.notFound);
    }
    return { kind: 'admin', id: admin.id, email: admin.email };
  }
}
