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
} from '@nestjs/common';
import { ApiCookieAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import { Request, Response } from 'express';
import { existsSync } from 'fs';
import { basename, join } from 'path';
import { AdminsStore } from '../../store/admins.store';
import { RolesStore } from '../../store/roles.store';
import { KycStore } from '../../store/kyc.store';
import { UsersStore } from '../../store/users.store';
import { AuditLogStore } from '../../store/audit-log.store';
import { COOKIE_BASES, readSessionCookie } from '../../common/security/session-cookies';
import {
  isTokenKind,
  TOKEN_ALGORITHMS,
  TOKEN_AUDIENCE,
  TOKEN_ISSUER,
  TOKEN_KIND,
} from '../../common/security/token-audience';

/** Who a request resolved to, and therefore what gets recorded about the read. */
type Reader =
  { kind: 'admin'; id: string; email: string } | { kind: 'client'; id: string; email: string };

// KYC documents are PII (ARCHITECTURE §8.5): never served anonymously.
// Same URL shape the static server used, so existing document URLs keep working:
//   - an admin holding kyc.review (or '*') may fetch any document
//   - a client may fetch only files referenced by their own submission
// Real signed URLs arrive with the S3 move; this closes the anonymous hole now.
@ApiTags('compliance')
@Controller('uploads')
export class UploadsController {
  private readonly logger = new Logger(UploadsController.name);

  constructor(
    private readonly jwt: JwtService,
    private readonly config: ConfigService,
    private readonly admins: AdminsStore,
    private readonly roles: RolesStore,
    private readonly kyc: KycStore,
    private readonly users: UsersStore,
    private readonly auditLog: AuditLogStore,
  ) {}

  @Get('kyc/:file')
  @ApiCookieAuth()
  @ApiOperation({
    summary: 'Serve a KYC document to its owner or a kyc.review admin',
  })
  async serveKycFile(@Param('file') file: string, @Req() req: Request, @Res() res: Response) {
    const name = basename(file); // neutralize any traversal attempt

    const reader = await this.authorize(req, name);

    const fullPath = join(process.cwd(), 'uploads', 'kyc', name);
    if (!existsSync(fullPath)) throw new NotFoundException('Document not found.');

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
    await this.recordRead(reader, name);

    // Never let the browser interpret a KYC document as active content on this
    // origin — this origin holds the session cookies.
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Disposition', `inline; filename="${name}"`);
    res.setHeader('Content-Security-Policy', "default-src 'none'; sandbox");
    /*
     * Do not let an identity document settle into a disk cache.
     *
     * `sendFile` sets ETag and Last-Modified and no Cache-Control, so a browser
     * applies its own heuristic freshness and may write the file to disk. The
     * account that reads these is the reviewer's, which opens every client's
     * passport in the course of the working day — so the default leaves a
     * growing pile of other people's identity documents in a cache directory
     * that outlives the session and that nothing here can clear.
     *
     * It also matters for what comes next: when ARCHITECTURE §8.5's signed URLs
     * arrive, a cached response is a credentialled response sitting on disk past
     * its TTL.
     */
    res.setHeader('Cache-Control', 'no-store, private');
    return res.sendFile(fullPath);
  }

  /**
   * Append one row per document read.
   *
   * The filename is the subject: it is a random UUID chosen by this system
   * (kyc.controller.ts) and carries nothing about the person, so the audit trail
   * identifies the document without copying identity data into a second table.
   */
  private async recordRead(reader: Reader, fileName: string): Promise<void> {
    try {
      await this.auditLog.record({
        actorId: reader.id,
        actorEmail: reader.email,
        action: reader.kind === 'admin' ? 'kyc.document.view' : 'kyc.document.view.own',
        subjectType: 'kyc_document',
        subjectId: fileName,
        details: { readerKind: reader.kind },
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
  private async authorize(req: Request, fileName: string): Promise<Reader> {
    const cookies = req.cookies as Record<string, string | undefined> | undefined;

    const adminToken = readSessionCookie(cookies, COOKIE_BASES.adminAccess);
    if (adminToken) {
      try {
        const payload = this.jwt.verify<{ sub: string; typ?: string }>(adminToken, {
          secret: this.config.getOrThrow<string>('ADMIN_JWT_SECRET'),
          audience: TOKEN_AUDIENCE.admin,
          issuer: TOKEN_ISSUER,
          // Stated, never inherited from the key type — see token-audience.ts.
          algorithms: TOKEN_ALGORITHMS,
        });
        // `typ` checked here too, as it is at every other verification site.
        // The separate refresh secret already makes a refresh token fail above,
        // so this is defence against that separation being lost in a deploy —
        // the same reason admin.guard.ts and jwt.strategy.ts check it.
        if (!isTokenKind(payload, TOKEN_KIND.access)) {
          throw new UnauthorizedException('Invalid or expired admin token.');
        }
        const admin = await this.admins.findById(payload.sub);
        if (admin) {
          const held = await this.roles.resolvePermissions(admin.roleId, admin.permissions);
          // One spelling — see migration 0009 and admin.guard.ts.
          const normalized = held.map((p) => p.toLowerCase());
          if (held.includes('*') || normalized.includes('kyc.review')) {
            return { kind: 'admin', id: admin.id, email: admin.email };
          }
          throw new ForbiddenException('The kyc.review permission is required to view documents.');
        }
      } catch (e) {
        if (e instanceof ForbiddenException) throw e;
        // fall through to client auth
      }
    }

    const clientToken = readSessionCookie(cookies, COOKIE_BASES.clientAccess);
    if (clientToken) {
      try {
        const payload = this.jwt.verify<{ sub: string; typ?: string }>(clientToken, {
          secret: this.config.getOrThrow<string>('JWT_ACCESS_SECRET'),
          audience: TOKEN_AUDIENCE.portal,
          issuer: TOKEN_ISSUER,
          // Stated, never inherited from the key type — see token-audience.ts.
          algorithms: TOKEN_ALGORITHMS,
        });
        if (!isTokenKind(payload, TOKEN_KIND.access)) {
          throw new UnauthorizedException('Invalid or expired token.');
        }
        if (await this.submissionReferencesFile(payload.sub, fileName)) {
          const owner = await this.users.findById(payload.sub);
          return { kind: 'client', id: payload.sub, email: owner?.email ?? 'unknown' };
        }
        throw new ForbiddenException('You can only access your own documents.');
      } catch (e) {
        if (e instanceof ForbiddenException) throw e;
      }
    }

    throw new UnauthorizedException('Authentication required to access documents.');
  }

  private async submissionReferencesFile(userId: string, fileName: string): Promise<boolean> {
    const sub = await this.kyc.findByUserId(userId);
    if (!sub) return false;
    const paths = [
      sub.document?.frontFilePath,
      sub.document?.backFilePath,
      sub.selfie?.filePath,
      sub.addressProof?.filePath,
      sub.addressProof?.page2FilePath,
    ];
    return paths.some((p) => p && basename(p) === fileName);
  }
}
