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
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import { Request, Response } from 'express';
import { basename } from 'path';
import { EmailVerifiedGuard } from '../identity/guards/email-verified.guard';
import { EmailNotVerifiedError } from '../../common/errors/domain-errors';
import { AdminsStore, type Admin } from '../../store/admins.store';
import { RolesStore } from '../../store/roles.store';
import { ClientIdentityService } from '../client-identity/client-identity.service';
import { UsersStore } from '../../store/users.store';
import { AuditLogStore } from '../../store/audit-log.store';
import { DepositProofsStore } from '../../store/deposit-proofs.store';
import { AdminClientScopesStore } from '../../store/admin-client-scopes.store';
import { AdminIpAllowlistStore } from '../../store/admin-ip-allowlist.store';
import { RefreshTokensService } from '../../common/security/refresh-tokens.service';
import { adminNetworkAdmits } from '../../common/security/admin-network';
import { clientIp } from '../../common/security/client-ip';
import { COOKIE_BASES, readSessionCookie } from '../../common/security/session-cookies';
import { JwtAuthGuard } from '../identity/guards/jwt-auth.guard';
import { AdminGuard, AnyAdmin } from '../admin/guards/admin.guard';
import {
  AVATAR_BUCKET,
  DEPOSIT_PROOF_BUCKET,
  KYC_BUCKET,
  PAYMENT_LOGO_BUCKET,
  StoredFilesService,
} from '../../common/uploads/stored-files.service';
import { inlineDisposition, streamObject } from '../../common/uploads/stream-object';
import {
  isTokenKind,
  TOKEN_ALGORITHMS,
  TOKEN_CLOCK_TOLERANCE_SECONDS,
  TOKEN_AUDIENCE,
  TOKEN_ISSUER,
  TOKEN_KIND,
} from '../../common/security/token-audience';

/** Who a request resolved to, and therefore what gets recorded about the read. */
type Reader =
  { kind: 'admin'; id: string; email: string } | { kind: 'client'; id: string; email: string };

/**
 * WHO may read a file in a given bucket — the four questions that differ between
 * one protected bucket and the next.
 *
 * Everything ABOVE this in `authorize` is identical for every bucket and is the
 * part that has historically been wrong: the token-kind check, the suspension
 * and revoked-family checks, the password-change cutoff, the RBAC-08 allowlist,
 * and the exact list of exceptions that may propagate rather than fall through.
 * A second copy of that for deposit receipts would be a second place for those
 * to drift; a policy object keeps one copy and varies only the decision.
 */
interface ReadPolicy {
  /** Which permission keys let an admin read here. */
  mayRead(permissions: string[]): boolean;
  /** Refuse a scoped admin who cannot see the owning client. Throws 404, never 403. */
  assertInScope(admin: Admin, fileName: string): Promise<void>;
  /** Does this client own this file? */
  clientOwns(userId: string, fileName: string): Promise<boolean>;
  /** The R-6.6 audit row this read writes. */
  audit: { action: string; subjectType: string };
  adminForbidden: string;
  clientForbidden: string;
}

// KYC documents are PII (ARCHITECTURE §8.5): never served anonymously.
// Same URL shape the static server used, so existing document URLs keep working:
//   - an admin holding kyc.review (or '*') may fetch any document
//   - a client may fetch only files referenced by their own submission
// Real signed URLs arrive with the S3 move; this closes the anonymous hole now.
@ApiTags('compliance')
/**
 * A session that WAS valid and has since been ended — suspension, a revoked
 * family, a password change. A 401, but one reached ON PURPOSE, which the
 * `authorize()` catches must propagate rather than retry as the other surface.
 */
class SessionEndedException extends UnauthorizedException {}

@Controller('uploads')
export class UploadsController {
  private readonly logger = new Logger(UploadsController.name);

  constructor(
    private readonly jwt: JwtService,
    private readonly config: ConfigService,
    private readonly admins: AdminsStore,
    private readonly roles: RolesStore,
    private readonly identity: ClientIdentityService,
    private readonly users: UsersStore,
    private readonly auditLog: AuditLogStore,
    private readonly files: StoredFilesService,
    private readonly scopes: AdminClientScopesStore,
    private readonly ipAllowlist: AdminIpAllowlistStore,
    private readonly refreshTokens: RefreshTokensService,
    private readonly depositProofs: DepositProofsStore,
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
    @Req() req: Request & { user: { id: string } },
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
   * Same shape as the KYC document route above, and deliberately so — the
   * differences are the bucket, the permissions, the ownership question and the
   * audit action, which are exactly the four things `ReadPolicy` carries.
   *
   * No `@UseGuards`: this route serves TWO principals, and which one is acting is
   * only knowable after the token resolves. `authorize` does it by hand, applying
   * every check the ordinary guards would — including the RBAC-08 allowlist,
   * which `IpAllowlistGuard` never sees here because `/uploads` is outside
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
    const name = basename(file); // neutralize any traversal attempt
    const policy = this.depositProofPolicy();
    const reader = await this.authorize(req, name, policy);

    const contentType = this.files.contentType(DEPOSIT_PROOF_BUCKET, name);
    if (!contentType) throw new NotFoundException('Receipt not found.');

    // `Range` forwarded so a multi-page PDF advice paints its first page without
    // the whole transfer; `If-None-Match` deliberately not, because the response
    // is `no-store` below and a revalidation path answers the opposite question.
    const found = await this.files.read(DEPOSIT_PROOF_BUCKET, name, { range: req.headers.range });
    if (!found) throw new NotFoundException('Receipt not found.');

    // Before any byte, and awaited: a failure to record is a failure to serve.
    // A receipt is PII of the same order as a KYC document — it carries a bank
    // account, a name and an amount.
    await this.recordRead(reader, name, policy.audit);

    streamObject(res, found, {
      contentType,
      // `no-store` for the KYC reason: a reviewer works through a queue of these,
      // and a browser's own freshness heuristics would leave a pile of other
      // people's bank details in a cache directory that outlives the session.
      cacheControl: 'no-store, private',
      contentSecurityPolicy: "default-src 'none'; sandbox",
      contentDisposition: inlineDisposition(name),
    });
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
    const name = basename(file); // neutralize any traversal attempt

    const reader = await this.authorize(req, name, this.kycPolicy());

    /*
     * The type comes from the STORED extension, which records what the magic bytes
     * were at upload. `sendFile` used to derive it; streaming from object storage
     * means setting it explicitly, and an unrecognised extension is a 404 rather
     * than a guess — guessing is the sniffing `nosniff` forbids.
     */
    const contentType = this.files.contentType(KYC_BUCKET, name);
    if (!contentType) throw new NotFoundException('Document not found.');

    /*
     * `Range` is forwarded; `If-None-Match` deliberately is NOT.
     *
     * A browser PDF viewer fetches the trailer and the first page by range, so
     * without this a reviewer waits for a whole 10MB scan before anything paints.
     * Conditional caching is a different matter: the response is `no-store` below,
     * so offering a revalidation path would invite exactly the cached copy that
     * header exists to prevent.
     */
    const found = await this.files.read(KYC_BUCKET, name, { range: req.headers.range });
    if (!found) throw new NotFoundException('Document not found.');

    // Recorded BEFORE the bytes are sent, and awaited rather than detached.
    //
    // PLATFORM-CONVENTIONS R-6.6: "which admin viewed this client's passport" is
    // a routine question in a compliance review and had no answer — this handler
    // authorized reads correctly and recorded nothing at all. Awaiting it means a
    // failure to record is a failure to serve, which is the right trade for the
    // one class of access the business must be able to account for afterwards.
    //
    // A client fetching their own document is recorded too. It is the same PII,
    // and an access log with a hole in it invites the question of what else is
    // missing.
    //
    // Still before any byte reaches the wire, and still after the object is known
    // to exist — so a read of a document that is not there writes no row claiming
    // it was viewed.
    await this.recordRead(reader, name, this.kycPolicy().audit);

    streamObject(res, found, {
      contentType,
      /*
       * Do not let an identity document settle into a disk cache.
       *
       * The account that reads these is the reviewer's, which opens every client's
       * passport in the course of the working day — so a browser's own heuristic
       * freshness leaves a growing pile of other people's identity documents in a
       * cache directory that outlives the session and that nothing here can clear.
       *
       * This is also why no `ETag` revalidation is offered above: `no-store` and a
       * conditional request are answers to opposite questions.
       */
      cacheControl: 'no-store, private',
      // Never let the browser interpret a KYC document as active content on this
      // origin — this origin holds the session cookies.
      contentSecurityPolicy: "default-src 'none'; sandbox",
      contentDisposition: inlineDisposition(name),
    });
  }

  /**
   * Append one row per document read.
   *
   * The filename is the subject: it is a random UUID chosen by this system
   * (kyc.controller.ts) and carries nothing about the person, so the audit trail
   * identifies the document without copying identity data into a second table.
   */
  private async recordRead(
    reader: Reader,
    fileName: string,
    audit: { action: string; subjectType: string },
  ): Promise<void> {
    try {
      await this.auditLog.record({
        actorId: reader.id,
        actorEmail: reader.email,
        actorKind: reader.kind,
        /*
         * ONE action name for both principals now.
         *
         * This used to be `kyc.document.view` for an admin and
         * `kyc.document.view.own` for a client, because the table had no column
         * for WHO was acting and the action name was the only place to put it.
         * That made "every read of this document" two queries instead of one,
         * and it meant a new kind of reader would have needed a third action
         * name. `actor_kind` is where that belongs.
         */
        action: audit.action,
        subjectType: audit.subjectType,
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
   * Authorize the read AND identify the reader.
   *
   * This used to return a bare `boolean`, which is why nothing could be
   * recorded: by the time the handler knew the request was allowed, it had
   * already thrown away who was asking. Returning the principal is what makes
   * R-6.6's audit row possible, and it costs nothing — both branches had already
   * resolved the account in order to decide.
   *
   * The two branches stay distinct on purpose (R-4.4): "may this actor read this
   * KIND of thing" is a permission check, and "may they read THIS file" is an
   * ownership check, and only the second one consults the submission.
   */
  private async authorize(req: Request, fileName: string, policy: ReadPolicy): Promise<Reader> {
    const cookies = req.cookies as Record<string, string | undefined> | undefined;

    const adminToken = readSessionCookie(cookies, COOKIE_BASES.adminAccess);
    if (adminToken) {
      try {
        const payload = this.jwt.verify<{ sub: string; typ?: string; fam?: string; iat?: number }>(
          adminToken,
          {
            secret: this.config.getOrThrow<string>('ADMIN_JWT_SECRET'),
            audience: TOKEN_AUDIENCE.admin,
            issuer: TOKEN_ISSUER,
            // Stated, never inherited from the key type — see token-audience.ts.
            algorithms: TOKEN_ALGORITHMS,
            clockTolerance: TOKEN_CLOCK_TOLERANCE_SECONDS,
          },
        );
        // `typ` checked here too, as it is at every other verification site.
        // The separate refresh secret already makes a refresh token fail above,
        // so this is defence against that separation being lost in a deploy —
        // the same reason admin.guard.ts and jwt.strategy.ts check it.
        if (!isTokenKind(payload, TOKEN_KIND.access)) {
          throw new UnauthorizedException('Invalid or expired admin token.');
        }
        const admin = await this.admins.findById(payload.sub);
        if (admin) {
          /*
           * THE THREE CHECKS EVERY OTHER ADMIN REQUEST GETS — suspension, the
           * revoked-family check, and the password-change cutoff — exactly as
           * `AdminAuthenticator` applies them. This route authenticates by hand
           * (it serves two surfaces), and for as long as it skipped them a
           * suspended administrator, one signed out from another device, or one
           * whose password had just been reset under duress kept reading every
           * client's passport for the rest of their access token's life. The
           * most sensitive bytes in the system were behind the weakest check.
           */
          this.assertAdminSessionLive(admin, payload);
          if (payload.fam && (await this.refreshTokens.familyIsRevoked('admin', payload.fam))) {
            throw new UnauthorizedException('Session has been revoked. Please log in again.');
          }
          /*
           * RBAC-08 APPLIES HERE, NOT IN THE GUARD — and this is the gap the
           * feature's deletion went out of its way to document.
           *
           * `IpAllowlistGuard` covers the admin surface by path, and this route
           * is `/uploads/kyc/:file` — outside `/admin`. While the allowlist
           * existed without this check, every client's passport, national ID and
           * proof of address was readable from any network on earth with a valid
           * admin session, while the allowlist reported itself as enforcing.
           *
           * It cannot move into the guard, because this route serves BOTH
           * surfaces: a client fetching their own document, and an admin
           * fetching anyone's. A network restriction on the client path would
           * lock customers out of their own files. Which principal is acting is
           * only known here, after the token resolves — so the CHECK lives here
           * and the RULE lives in `adminNetworkAdmits` (R-4.3), shared with the
           * guard so the two can never disagree.
           *
           * Deliberately BEFORE the permission check: being on a permitted
           * network is a precondition for exercising admin authority at all,
           * not a second opinion about which admin you are.
           */
          /*
           * Fails OPEN on an unreadable list, for the same reason the guard
           * does — see `IpAllowlistGuard`. A missing table here would 500 every
           * KYC document read, and a reviewer would meet an internal error on
           * the document rather than an explanation.
           */
          let allowlistRules: string[] = [];
          try {
            allowlistRules = await this.ipAllowlist.listCidrs();
          } catch (error) {
            this.logger.error(
              'RBAC-08 could not read the IP allowlist, so the network restriction on KYC ' +
                'document reads is NOT being enforced. This usually means migrations are ' +
                `pending — run \`npm run db:migrate\`. Cause: ${
                  error instanceof Error ? error.message : String(error)
                }`,
            );
          }
          const callerIp = clientIp(req);
          if (!adminNetworkAdmits(allowlistRules, callerIp)) {
            this.logger.warn(
              `Admin ${admin.email} refused a KYC document read from ${callerIp ?? 'an unknown address'}: ` +
                `not in the IP allowlist (${allowlistRules.length} rule(s) configured).`,
            );
            throw new ForbiddenException(
              'Your network is not permitted to reach the administration API.',
            );
          }

          const held = await this.roles.resolvePermissions(admin.roleId, admin.permissions);
          // One spelling — see migration 0009 and admin.guard.ts.
          const normalized = held.map((p) => p.toLowerCase());
          /*
           * READING a document and DECIDING an outcome are different powers.
           *
           * Both used to require `kyc.review`, so an auditor who needed to
           * inspect submissions had to be granted the permission that also
           * promotes accounts to verification level 1 — which is what opens the
           * withdrawal gate. That is a large grant to make for a read.
           *
           * `kyc.documents.view` is the read on its own. `kyc.review` still
           * implies it, deliberately: a reviewer who could not open the
           * documents could not review anything, and requiring both keys would
           * silently break every existing reviewer on deploy. So this widens who
           * may look without changing who may decide.
           */
          // No wildcard branch: full access is a real list of real keys now
          // (admin.guard.ts), and this was the last reader of `'*'`.
          const mayRead = policy.mayRead(normalized);
          if (mayRead) {
            /*
             * CLIENT SCOPE, on a route that takes a FILENAME rather than a
             * client id.
             *
             * That is exactly why it was the sneakiest gap. A scoped admin who
             * cannot open a client's profile can still hold one of their
             * document filenames — from a screenshot, a stale tab, a shared
             * ticket — and this route had nothing to check it against. The
             * read would have been served AND audited as legitimate.
             *
             * Resolved to the owning client and checked, before any bytes and
             * before the R-6.6 audit row, so a refused read leaves no trace
             * claiming it happened.
             */
            await policy.assertInScope(admin, fileName);
            return { kind: 'admin', id: admin.id, email: admin.email };
          }
          throw new ForbiddenException(policy.adminForbidden);
        }
      } catch (e) {
        /*
         * A DELIBERATE DECISION about this admin propagates; anything else
         * falls through to the client branch.
         *
         * The list matters and is easy to get wrong. It held only
         * `ForbiddenException`, so the `NotFoundException` raised by the client
         * scope check below was swallowed and the request continued into the
         * portal branch, ending as a 401 "authentication required" — to an
         * administrator who was authenticated, about a document that exists.
         * The read was still refused, so nothing leaked; the answer was simply
         * a lie about why.
         *
         * Falling through is right only for "this is not an admin request after
         * all" — an unverifiable cookie, a missing admin row. A refusal we
         * reached ON PURPOSE is an answer, and answers are not retried as
         * somebody else.
         */
        if (
          e instanceof ForbiddenException ||
          e instanceof NotFoundException ||
          e instanceof SessionEndedException
        ) {
          throw e;
        }
        // fall through to client auth
      }
    }

    const clientToken = readSessionCookie(cookies, COOKIE_BASES.clientAccess);
    if (clientToken) {
      try {
        const payload = this.jwt.verify<{ sub: string; typ?: string; fam?: string; iat?: number }>(
          clientToken,
          {
            secret: this.config.getOrThrow<string>('JWT_ACCESS_SECRET'),
            audience: TOKEN_AUDIENCE.portal,
            issuer: TOKEN_ISSUER,
            // Stated, never inherited from the key type — see token-audience.ts.
            algorithms: TOKEN_ALGORITHMS,
            clockTolerance: TOKEN_CLOCK_TOLERANCE_SECONDS,
          },
        );
        if (!isTokenKind(payload, TOKEN_KIND.access)) {
          throw new UnauthorizedException('Invalid or expired token.');
        }
        /*
         * The same three checks `JwtStrategy.validate` applies on every other
         * portal request — see the admin branch for why a bespoke
         * authentication path must not be the weakest one.
         */
        const owner = await this.users.findById(payload.sub);
        if (owner) this.assertClientSessionLive(owner, payload);
        if (payload.fam && (await this.refreshTokens.familyIsRevoked('portal', payload.fam))) {
          throw new UnauthorizedException('That session has been signed out. Please log in again.');
        }
        if (await policy.clientOwns(payload.sub, fileName)) {
          /*
           * The CLIENT branch checks `emailVerified`; the admin branch above
           * cannot and must not — an admin has no such column, and testing it
           * there would lock every reviewer out of every document.
           *
           * It is checked HERE rather than by a controller-level guard for that
           * exact reason: which principal is acting is only knowable after the
           * token resolves, so the guard cannot see the difference. Same
           * reasoning the removed network check recorded above.
           *
           * A client reaching this point owns the document — they cannot see
           * anyone else's either way — so this is not about the file. It is that
           * an unverified address makes "this account holder" a claim nobody
           * confirmed, and their passport is the most sensitive thing here.
           */
          if (owner && !owner.emailVerified) {
            throw new EmailNotVerifiedError(
              'Please verify your email address before accessing your documents.',
            );
          }
          return { kind: 'client', id: payload.sub, email: owner?.email ?? 'unknown' };
        }
        throw new ForbiddenException(policy.clientForbidden);
      } catch (e) {
        /*
         * `EmailNotVerifiedError` propagates alongside `ForbiddenException`, for
         * the reason the admin branch's catch spells out: a refusal reached ON
         * PURPOSE is an answer, and swallowing it here would fall through to the
         * generic "Authentication required" below — telling a signed-in client
         * they are not signed in, and losing the EMAIL_NOT_VERIFIED code the
         * portal needs to offer the resend.
         */
        if (
          e instanceof ForbiddenException ||
          e instanceof EmailNotVerifiedError ||
          e instanceof SessionEndedException
        ) {
          throw e;
        }
      }
    }

    throw new UnauthorizedException('Authentication required to access documents.');
  }

  /**
   * Suspension and the password-change cutoff, for an ADMIN access token —
   * the arithmetic mirrors admin.guard.ts exactly (`(iat + 1) * 1000 <=
   * cutoff`, failing closed at the boundary). Thrown as `SessionEndedException`
   * so the catch above propagates it as the deliberate 401 it is, rather than
   * falling through to "Authentication required" as if nobody had signed in.
   */
  private assertAdminSessionLive(
    admin: Pick<Admin, 'status' | 'passwordChangedAt'>,
    payload: { iat?: number },
  ): void {
    if (admin.status === 'suspended') {
      throw new SessionEndedException('This administrator account has been suspended.');
    }
    if (
      admin.passwordChangedAt &&
      payload.iat &&
      (payload.iat + 1) * 1000 <= admin.passwordChangedAt.getTime()
    ) {
      throw new SessionEndedException('Your password was changed. Please sign in again.');
    }
  }

  /** The portal counterpart — mirrors `JwtStrategy.validate`. */
  private assertClientSessionLive(
    user: { status: string; passwordChangedAt?: Date | null },
    payload: { iat?: number },
  ): void {
    if (user.status === 'suspended') {
      throw new SessionEndedException('Your account has been suspended.');
    }
    if (
      user.passwordChangedAt &&
      payload.iat &&
      (payload.iat + 1) * 1000 <= user.passwordChangedAt.getTime()
    ) {
      throw new SessionEndedException('Your password was changed. Please sign in again.');
    }
  }

  /**
   * A scoped administrator may only read documents belonging to clients inside
   * their own territory.
   *
   * 404, not 403, and the wording matches the genuinely-missing case above
   * exactly: distinguishing them would tell a scoped admin which filenames are
   * real, which is the enumeration this route is most exposed to.
   */
  /**
   * KYC documents — the policy this route has always applied, now stated.
   *
   * `kyc.review` implies the read deliberately: a reviewer who could not open
   * the documents could not review anything, and requiring both keys would have
   * broken every existing reviewer on deploy.
   */
  private kycPolicy(): ReadPolicy {
    return {
      mayRead: (permissions) =>
        permissions.includes('kyc.documents.view') || permissions.includes('kyc.review'),
      assertInScope: (admin, fileName) => this.assertDocumentInScope(admin, fileName),
      clientOwns: (userId, fileName) => this.clientOwnsDocument(userId, fileName),
      audit: { action: 'kyc.document.view', subjectType: 'kyc_document' },
      adminForbidden:
        'The kyc.documents.view or kyc.review permission is required to view documents.',
      clientForbidden: 'You can only access your own documents.',
    };
  }

  /**
   * Deposit receipts — a client's proof that they paid from outside the system.
   *
   * `deposits.approve` implies the read for the KYC reason above: approving a
   * deposit without being able to see the receipt is approving blind. The
   * separate `deposits.proofs.view` exists for the reviewer who checks the bank
   * statement without holding the power to credit.
   *
   * NOT readable by a `kyc.*` holder, and that is the point of a second policy:
   * a receipt names a bank account and an amount, and the people who verify
   * identity are not necessarily the people who handle money.
   */
  private depositProofPolicy(): ReadPolicy {
    return {
      mayRead: (permissions) =>
        permissions.includes('deposits.proofs.view') || permissions.includes('deposits.approve'),
      assertInScope: (admin, fileName) => this.assertProofInScope(admin, fileName),
      clientOwns: async (userId, fileName) =>
        (await this.depositProofs.ownerOfProof(fileName)) === userId,
      audit: { action: 'deposit.proof.view', subjectType: 'deposit_proof' },
      adminForbidden:
        'The deposits.proofs.view or deposits.approve permission is required to view receipts.',
      clientForbidden: 'You can only access your own receipts.',
    };
  }

  /**
   * The deposit-receipt twin of `assertDocumentInScope`, and 404 for the same
   * reason: telling a scoped admin that a filename is real but not theirs is
   * itself a disclosure.
   *
   * The owner comes from the DEPOSIT, not from `stored_objects.owner_user_id` —
   * the authority on whose receipt this is, is whose deposit it belongs to.
   */
  private async assertProofInScope(admin: Admin, fileName: string): Promise<void> {
    const scope = await this.scopes.scopeFor(admin);
    if (scope.unrestricted) return;

    const owner = await this.depositProofs.ownerOfProof(fileName);
    if (!owner) throw new NotFoundException('Receipt not found.');
    const client = await this.users.findForAdmin(owner, scope);
    if (!client) throw new NotFoundException('Receipt not found.');
  }

  private async assertDocumentInScope(admin: Admin, fileName: string): Promise<void> {
    /*
     * The OWNER first, for EVERY admin — scoped or not.
     *
     * A file no client's record holds is an orphan: a replaced draft page whose
     * deletion failed, the leftovers of a reset, a name somebody guessed. It is
     * nobody's document, so there is nothing to serve. Until 28 Sep 2026 an
     * UNRESTRICTED admin skipped this lookup and was handed any file in the
     * documents bucket by name — the one reader with no owner check at all.
     */
    const owner = await this.identity.ownerOfKycFile(fileName);
    if (!owner) throw new NotFoundException('Document not found.');

    // The admin's own intake grant (D-60), not a default — an intake-granted
    // reviewer must reach an untagged client's DOCUMENTS, not just the
    // submission row.
    const scope = await this.scopes.scopeFor(admin);
    if (scope.unrestricted) return;
    const client = await this.users.findForAdmin(owner, scope);
    if (!client) throw new NotFoundException('Document not found.');
  }

  /**
   * Does this client own this document? Their identity RECORD says (0151):
   * every version of every document they ever presented or are working on —
   * the live submission, a returned attempt, a broker's own upload step, and
   * what was decided before a reset.
   *
   * It used to be read from the KYC rows, and the reset was the hole: the live
   * row goes, and the check stopped at "no submission", so a client lost their
   * own archived passport — while any reviewing admin could still open it.
   */
  private async clientOwnsDocument(userId: string, fileName: string): Promise<boolean> {
    return (await this.identity.ownerOfKycFile(fileName)) === userId;
  }
}
