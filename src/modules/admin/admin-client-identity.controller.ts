import { Controller, Get, Param, Req, UseGuards } from '@nestjs/common';
import { ApiCookieAuth, ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Request } from 'express';
import { ClientRefPipe } from '../../common/client-ref.pipe';
import { AdminClientIdentityService } from './admin-client-identity.service';
import { ClientIdentityRecordDto } from './dto/client-identity.dto';
import { ClientDocumentListDto } from './dto/client-documents.dto';
import {
  PermissionsGuard,
  RequirePermissions,
  type AuthenticatedAdmin,
} from './guards/admin.guard';
import { ScopedToClients } from './guards/client-scope.decorator';

/** A client's identity record — documents, their versions, and every decision. */
@ApiTags('admin')
@Controller('admin')
export class AdminClientIdentityController {
  constructor(private readonly identity: AdminClientIdentityService) {}

  @Get('clients/:id/identity')
  @UseGuards(PermissionsGuard)
  @RequirePermissions('clients.view')
  @ApiCookieAuth()
  @ApiOperation({
    summary: "A client's identity record: every document version, and every verification decision",
    description:
      'Documents need kyc.documents.view (or kyc.review) and decisions need kyc.view; a half the ' +
      'reader may not see is ABSENT, not empty.',
  })
  @ApiOkResponse({ type: ClientIdentityRecordDto })
  @ScopedToClients(
    'UsersStore.findForAdmin(id, scope) — an out-of-scope client is 404, identically to a missing one.',
  )
  recordFor(
    @Param('id', ClientRefPipe) id: number,
    @Req() req: Request & { admin: AuthenticatedAdmin },
  ): Promise<ClientIdentityRecordDto> {
    return this.identity.recordFor(id, req.admin);
  }
  @Get('clients/:id/documents')
  @UseGuards(PermissionsGuard)
  @RequirePermissions('clients.view')
  @ApiCookieAuth()
  @ApiOperation({
    summary: 'Every document a client has handed the platform, each with where it stands',
    description:
      'KYC document versions (with their review status) and offline-deposit receipts (with ' +
      "their deposit's state — a receipt on a refused deposit reads rejected), newest first. " +
      'KYC needs kyc.documents.view or kyc.review; receipts need deposits.proofs.view or ' +
      'deposits.approve — a half the reader may not see is named in `hidden`.',
  })
  @ApiOkResponse({ type: ClientDocumentListDto })
  @ScopedToClients(
    'UsersStore.findForAdmin(id, scope) — an out-of-scope client is 404, identically to a missing one.',
  )
  documentsFor(
    @Param('id', ClientRefPipe) id: number,
    @Req() req: Request & { admin: AuthenticatedAdmin },
  ): Promise<ClientDocumentListDto> {
    return this.identity.documentsFor(id, req.admin);
  }
}
