import {
  Body,
  Controller,
  DefaultValuePipe,
  Get,
  Param,
  ParseEnumPipe,
  ParseIntPipe,
  Post,
  Put,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { ApiCookieAuth, ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Request } from 'express';
import {
  AuthenticatedAdmin,
  PermissionsGuard,
  RequirePermissions,
} from '../../admin/guards/admin.guard';
import { NotClientScoped } from '../../admin/guards/client-scope.decorator';
import { Audited, NotAudited } from '../../admin/guards/audited.decorator';
import { PaymentProvidersService } from './payment-providers.service';
import {
  PaymentProviderDto,
  ProviderEventDto,
  ProviderTestResultDto,
  RotatedProviderSecretDto,
  SetProviderChannelDto,
  UpdatePaymentProviderDto,
} from '../dto/payment-provider.dto';

const NOT_SCOPED = 'Platform payment configuration; names no client and returns no client data.';

/**
 * System → Payment providers (0168): every provider the build knows — its
 * connection, its channels, the methods on them, its health and what it last
 * reported. Replaces the Rival tab on Settings, whose routes stay until the
 * console no longer calls them.
 *
 * `payments.providers.view` / `.edit` (0168 granted them to whoever held
 * `settings.rival.view` / `.edit`): a provider's settings decide where every
 * payment and payout instruction goes, so they are not `payments.edit`, which
 * governs what clients are offered.
 */
@ApiTags('admin')
@Controller('admin/payment-providers')
export class AdminPaymentProvidersController {
  constructor(private readonly providers: PaymentProvidersService) {}

  @Get()
  @UseGuards(PermissionsGuard)
  @RequirePermissions('payments.providers.view')
  @ApiCookieAuth()
  @ApiOperation({ summary: 'Every payment provider, with its state, channels and methods' })
  @ApiOkResponse({ type: PaymentProviderDto, isArray: true })
  @NotClientScoped(NOT_SCOPED)
  list() {
    return this.providers.list();
  }

  @Get(':code')
  @UseGuards(PermissionsGuard)
  @RequirePermissions('payments.providers.view')
  @ApiCookieAuth()
  @ApiOperation({ summary: 'One payment provider' })
  @ApiOkResponse({ type: PaymentProviderDto })
  @NotClientScoped(NOT_SCOPED)
  get(@Param('code') code: string) {
    return this.providers.get(code);
  }

  @Get(':code/events')
  @UseGuards(PermissionsGuard)
  @RequirePermissions('payments.providers.view')
  @ApiCookieAuth()
  @ApiOperation({
    summary: 'What the provider last reported, and what was done about it',
    description: 'Newest first, at most 200 (`limit`, default 50).',
  })
  @ApiOkResponse({ type: ProviderEventDto, isArray: true })
  @NotClientScoped(NOT_SCOPED)
  events(
    @Param('code') code: string,
    @Query('limit', new DefaultValuePipe(50), ParseIntPipe) limit: number,
  ) {
    return this.providers.recentEvents(code, limit);
  }

  @Put(':code')
  @UseGuards(PermissionsGuard)
  @RequirePermissions('payments.providers.edit')
  @ApiCookieAuth()
  @ApiOperation({
    summary: 'Change a provider’s settings, secrets, environment or switch',
    description:
      'Merged: an absent key is left as it is; `null` or an empty string removes one. Secrets ' +
      'are write-only. A generated secret (a webhook key) is rotated, never typed. Switching ' +
      'on needs every required setting; sandbox is refused on a production deployment.',
  })
  @ApiOkResponse({ type: PaymentProviderDto })
  @NotClientScoped(NOT_SCOPED)
  @Audited('payment_provider.update')
  update(
    @Req() req: Request & { admin: AuthenticatedAdmin },
    @Param('code') code: string,
    @Body() dto: UpdatePaymentProviderDto,
  ) {
    return this.providers.update(code, dto, req.admin);
  }

  @Post(':code/test')
  @UseGuards(PermissionsGuard)
  @RequirePermissions('payments.providers.edit')
  @ApiCookieAuth()
  @ApiOperation({
    summary: 'Test the connection with the saved settings',
    description: 'Changes no setting; the result becomes the provider’s health line.',
  })
  @ApiOkResponse({ type: ProviderTestResultDto })
  @NotClientScoped(NOT_SCOPED)
  @NotAudited(
    'Changes no setting — it asks the provider whether the saved ones work and keeps the answer ' +
      'as the health line; the settings it verifies are recorded by payment_provider.update.',
  )
  test(@Param('code') code: string) {
    return this.providers.test(code);
  }

  @Post(':code/secrets/:name/rotate')
  @UseGuards(PermissionsGuard)
  @RequirePermissions('payments.providers.edit')
  @ApiCookieAuth()
  @ApiOperation({
    summary: 'Generate a new value for a generated secret (a webhook key)',
    description:
      'Returned in plaintext THIS ONCE, to paste into the provider’s dashboard. Deliveries ' +
      'signed with the old one are refused from now until the dashboard is updated; the poller ' +
      'catches up on anything refused in between.',
  })
  @ApiOkResponse({ type: RotatedProviderSecretDto })
  @NotClientScoped(NOT_SCOPED)
  @Audited('payment_provider.secret_rotate')
  rotate(
    @Req() req: Request & { admin: AuthenticatedAdmin },
    @Param('code') code: string,
    @Param('name') name: string,
  ) {
    return this.providers.rotateSecret(code, name, req.admin);
  }

  @Put(':code/channels/:direction/:channel')
  @UseGuards(PermissionsGuard)
  @RequirePermissions('payments.providers.edit')
  @ApiCookieAuth()
  @ApiOperation({
    summary: 'Switch one of the provider’s channels on or off, in one direction',
    description:
      'E.g. ERC20 payouts off while TRC20 stays on. Off: its methods leave the client’s lists, ' +
      'new movements on it are refused and approving payouts on it pauses; movements already ' +
      'under way still finish. A reason is required to switch one off.',
  })
  @ApiOkResponse({ type: PaymentProviderDto })
  @NotClientScoped(NOT_SCOPED)
  @Audited('payment_provider.channel_disable')
  setChannel(
    @Req() req: Request & { admin: AuthenticatedAdmin },
    @Param('code') code: string,
    @Param('direction', new ParseEnumPipe(['deposit', 'payout'])) direction: 'deposit' | 'payout',
    @Param('channel') channel: string,
    @Body() dto: SetProviderChannelDto,
  ) {
    return this.providers.setChannel(
      code,
      direction,
      channel,
      dto.enabled,
      dto.reason ?? null,
      req.admin,
    );
  }
}
