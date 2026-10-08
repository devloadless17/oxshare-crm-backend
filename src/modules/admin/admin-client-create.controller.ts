import { Body, Controller, Param, Post, Req, UseGuards, UseInterceptors } from '@nestjs/common';
import { ApiCookieAuth, ApiOkResponse, ApiOperation, ApiProperty, ApiTags } from '@nestjs/swagger';
import { Request } from 'express';
import { AdminClientCreateService } from './admin-client-create.service';
import { CreateClientDto } from './dto/requests/clients.dto';
import { MessageResponseDto } from './dto/responses.dto';
import {
  PermissionsGuard,
  RequirePermissions,
  type AuthenticatedAdmin,
} from './guards/admin.guard';
import { ClientRefPipe } from '../../common/client-ref.pipe';
import { ScopedToClients } from './guards/client-scope.decorator';
import { Audited } from './guards/audited.decorator';
import { AnnouncesChange } from '../../common/realtime/announces-change.decorator';
import { Idempotent, IdempotencyInterceptor } from '../../common/security/idempotency.interceptor';
import { NoClientFields } from '../../common/security/client-field.decorator';

@NoClientFields('a reference to the record just created - its Portal ID, nothing about the person')
export class ClientCreatedDto {
  @ApiProperty({ type: 'integer', example: 1000245, description: 'The new client’s Portal ID.' })
  id: number;
}

/**
 * "New client" (0211): staff create a client for somebody who cannot sign up
 * themselves — see `AdminClientCreateService`.
 */
@ApiTags('admin')
@Controller('admin')
export class AdminClientCreateController {
  constructor(private readonly clients: AdminClientCreateService) {}

  /**
   * `Idempotency-Key` makes a retried click (a slow network, a double press) a
   * replay of the first creation rather than a second client.
   */
  @Post('clients')
  @UseInterceptors(IdempotencyInterceptor)
  @Idempotent()
  @AnnouncesChange('clients')
  @UseGuards(PermissionsGuard)
  @RequirePermissions('clients.create')
  @ApiCookieAuth()
  @ApiOperation({
    summary: 'Create a client for somebody who cannot sign up themselves',
    description:
      'The same checks as a sign-up: names, date of birth, nationality, phone and residence ' +
      'required, the offered countries, a free email and phone — each refusal under its field. ' +
      'The client gets the creator’s territory tags and a welcome email to choose their ' +
      'password; nobody else ever knows it. Refused (409) when the creator could not see the ' +
      'client afterwards, with nothing kept.',
  })
  @ApiOkResponse({ type: ClientCreatedDto })
  @ScopedToClients(
    'The NEW client must land in the creator’s territory: UsersStore.findForAdmin with the ' +
      'actor scope, inside the creating transaction — refused and rolled back otherwise.',
  )
  @Audited('client.created')
  create(@Body() dto: CreateClientDto, @Req() req: Request & { admin: AuthenticatedAdmin }) {
    return this.clients.create(dto, req.admin);
  }

  @Post('clients/:id/welcome')
  @AnnouncesChange('clients')
  @UseGuards(PermissionsGuard)
  @RequirePermissions('clients.create')
  @ApiCookieAuth()
  @ApiOperation({
    summary: 'Send a staff-created client their welcome email again',
    description: 'Only while they have not chosen a password yet. A new link replaces the old one.',
  })
  @ApiOkResponse({ type: MessageResponseDto })
  @ScopedToClients(
    'UsersStore.findForAdmin with the actor scope before anything is read — an out-of-scope ' +
      'client 404s exactly as a missing one does.',
  )
  @Audited('client.welcome_resend')
  resendWelcome(
    @Param('id', ClientRefPipe) id: number,
    @Req() req: Request & { admin: AuthenticatedAdmin },
  ) {
    return this.clients.resendWelcome(id, req.admin);
  }
}
