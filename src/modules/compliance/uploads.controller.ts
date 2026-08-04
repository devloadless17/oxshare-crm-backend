import {
  Controller,
  ForbiddenException,
  Get,
  NotFoundException,
  Param,
  Req,
  Res,
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
import { COOKIE_BASES, readSessionCookie } from '../../common/security/session-cookies';

// KYC documents are PII (ARCHITECTURE §8.5): never served anonymously.
// Same URL shape the static server used, so existing document URLs keep working:
//   - an admin holding kyc:review (or '*') may fetch any document
//   - a client may fetch only files referenced by their own submission
// Real signed URLs arrive with the S3 move; this closes the anonymous hole now.
@ApiTags('compliance')
@Controller('uploads')
export class UploadsController {
  constructor(
    private readonly jwt: JwtService,
    private readonly config: ConfigService,
    private readonly admins: AdminsStore,
    private readonly roles: RolesStore,
    private readonly kyc: KycStore,
  ) {}

  @Get('kyc/:file')
  @ApiCookieAuth()
  @ApiOperation({
    summary: 'Serve a KYC document to its owner or a kyc.review admin',
  })
  async serveKycFile(@Param('file') file: string, @Req() req: Request, @Res() res: Response) {
    const name = basename(file); // neutralize any traversal attempt

    if (!(await this.isAuthorized(req, name))) {
      // isAuthorized throws the precise error; this is unreachable, kept for clarity
      throw new ForbiddenException('Not allowed to access this document.');
    }

    const fullPath = join(process.cwd(), 'uploads', 'kyc', name);
    if (!existsSync(fullPath)) throw new NotFoundException('Document not found.');

    // Never let the browser interpret a KYC document as active content on this
    // origin — this origin holds the session cookies.
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Disposition', `inline; filename="${name}"`);
    res.setHeader('Content-Security-Policy', "default-src 'none'; sandbox");
    return res.sendFile(fullPath);
  }

  private async isAuthorized(req: Request, fileName: string): Promise<boolean> {
    const adminToken = readSessionCookie(
      req.cookies as Record<string, string | undefined> | undefined,
      COOKIE_BASES.adminAccess,
    );
    if (adminToken) {
      try {
        const payload = this.jwt.verify<{ sub: string }>(adminToken, {
          secret: this.config.getOrThrow<string>('ADMIN_JWT_SECRET'),
        });
        const admin = await this.admins.findById(payload.sub);
        if (admin) {
          const held = await this.roles.resolvePermissions(admin.roleId, admin.permissions);
          const normalized = held.map((p) => p.replace(/:/g, '.').toLowerCase());
          if (held.includes('*') || normalized.includes('kyc.review')) return true;
          throw new ForbiddenException('The kyc.review permission is required to view documents.');
        }
      } catch (e) {
        if (e instanceof ForbiddenException) throw e;
        // fall through to client auth
      }
    }

    const clientToken = readSessionCookie(
      req.cookies as Record<string, string | undefined> | undefined,
      COOKIE_BASES.clientAccess,
    );
    if (clientToken) {
      try {
        const payload = this.jwt.verify<{ sub: string }>(clientToken, {
          secret: this.config.getOrThrow<string>('JWT_ACCESS_SECRET'),
        });
        if (await this.submissionReferencesFile(payload.sub, fileName)) return true;
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
