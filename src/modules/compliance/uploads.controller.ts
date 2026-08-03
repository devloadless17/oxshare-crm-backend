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
import { resolvePermissions } from '../../store/roles.store';
import { KycStore } from '../../store/kyc.store';

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
  ) {}

  @Get('kyc/:file')
  @ApiCookieAuth()
  @ApiOperation({ summary: 'Serve a KYC document to its owner or a kyc.review admin' })
  serveKycFile(@Param('file') file: string, @Req() req: Request, @Res() res: Response) {
    const name = basename(file); // neutralize any traversal attempt

    if (!this.isAuthorized(req, name)) {
      // isAuthorized throws the precise error; this is unreachable, kept for clarity
      throw new ForbiddenException('Not allowed to access this document.');
    }

    const fullPath = join(process.cwd(), 'uploads', 'kyc', name);
    if (!existsSync(fullPath)) throw new NotFoundException('Document not found.');
    return res.sendFile(fullPath);
  }

  private isAuthorized(req: Request, fileName: string): boolean {
    const adminToken = req.cookies?.['admin_access_token'];
    if (adminToken) {
      try {
        const payload = this.jwt.verify<{ sub: string }>(adminToken, {
          secret: this.config.get('ADMIN_JWT_SECRET', 'oxshare-admin-secret-dev'),
        });
        const admin = AdminsStore.findById(payload.sub);
        if (admin) {
          const held = resolvePermissions(admin.roleId, admin.permissions);
          const normalized = held.map((p) => p.replace(/:/g, '.').toLowerCase());
          if (held.includes('*') || normalized.includes('kyc.review')) return true;
          throw new ForbiddenException('The kyc.review permission is required to view documents.');
        }
      } catch (e) {
        if (e instanceof ForbiddenException) throw e;
        // fall through to client auth
      }
    }

    const clientToken = req.cookies?.['access_token'];
    if (clientToken) {
      try {
        const payload = this.jwt.verify<{ sub: string }>(clientToken, {
          secret: this.config.get('JWT_ACCESS_SECRET', 'oxshare-access-secret-dev'),
        });
        if (this.submissionReferencesFile(payload.sub, fileName)) return true;
        throw new ForbiddenException('You can only access your own documents.');
      } catch (e) {
        if (e instanceof ForbiddenException) throw e;
      }
    }

    throw new UnauthorizedException('Authentication required to access documents.');
  }

  private submissionReferencesFile(userId: string, fileName: string): boolean {
    const sub = KycStore.findByUserId(userId);
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
