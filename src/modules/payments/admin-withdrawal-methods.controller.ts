import { Body, Controller, Delete, Get, Param, Patch, Post, Req, UseGuards } from '@nestjs/common';
import { ApiCookieAuth, ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Request } from 'express';
import {
  AuthenticatedAdmin,
  PermissionsGuard,
  RequirePermissions,
} from '../admin/guards/admin.guard';
import { NotClientScoped } from '../admin/guards/client-scope.decorator';
import { Audited } from '../admin/guards/audited.decorator';
import { WithdrawalMethodsService } from './withdrawal-methods.service';
import {
  AdminWithdrawalMethodDto,
  CreateWithdrawalMethodDto,
  UpdateWithdrawalMethodDto,
} from './dto/withdrawal-method.dto';
import { DeletedMethodDto } from './dto/payment-method.dto';

/**
 * Withdrawal methods — the payout rails the portal's withdraw form offers.
 *
 * The twin of `admin/payment-methods` (the DEPOSIT side), and deliberately
 * shaped like it: list everything, add one, patch one, delete one nobody used. Logos go
 * through the same upload, `POST /admin/payment-methods/logo`, whose URL both
 * tables accept.
 *
 * `@NotClientScoped`: platform configuration, naming no client and returning no
 * client data, identical for every admin who can see it.
 */
@ApiTags('admin')
@Controller('admin/withdrawal-methods')
export class AdminWithdrawalMethodsController {
  constructor(private readonly methods: WithdrawalMethodsService) {}

  @Get()
  @UseGuards(PermissionsGuard)
  @RequirePermissions('payments.view')
  @ApiCookieAuth()
  @ApiOperation({
    summary: 'Every withdrawal method, enabled or not',
    description:
      'Includes disabled methods — switching them is the point of the screen. Clients see only ' +
      'the enabled ones, through GET /payments/withdrawal-methods.',
  })
  @ApiOkResponse({ type: AdminWithdrawalMethodDto, isArray: true })
  @NotClientScoped('Platform payment configuration; names no client and returns no client data.')
  list() {
    return this.methods.listAll();
  }

  @Post()
  @UseGuards(PermissionsGuard)
  @RequirePermissions('payments.create')
  @ApiCookieAuth()
  @ApiOperation({
    summary: 'Add a withdrawal method',
    description:
      'Key, name and an optional logo. `enabled` decides whether clients are offered it on the ' +
      'withdraw form.',
  })
  @ApiOkResponse({ type: AdminWithdrawalMethodDto })
  @NotClientScoped('Platform payment configuration; names no client and returns no client data.')
  @Audited('withdrawal_method.create')
  create(
    @Req() req: Request & { admin: AuthenticatedAdmin },
    @Body() dto: CreateWithdrawalMethodDto,
  ) {
    return this.methods.create(dto, req.admin);
  }

  @Patch(':key')
  @UseGuards(PermissionsGuard)
  @RequirePermissions('payments.edit')
  @ApiCookieAuth()
  @ApiOperation({
    summary: 'Update a withdrawal method',
    description:
      'PATCH. `key` is permanent (0161); the desk renames a rail with `internalLabel`, shown on ' +
      'every admin screen instead of `name`. Disabling hides the method from new requests and ' +
      'leaves existing ones for the desk to settle.',
  })
  @ApiOkResponse({ type: AdminWithdrawalMethodDto })
  @NotClientScoped('Platform payment configuration; names no client and returns no client data.')
  @Audited('withdrawal_method.update')
  update(
    @Req() req: Request & { admin: AuthenticatedAdmin },
    @Param('key') key: string,
    @Body() dto: UpdateWithdrawalMethodDto,
  ) {
    return this.methods.update(key, dto, req.admin);
  }

  @Delete(':key')
  @UseGuards(PermissionsGuard)
  @RequirePermissions('payments.edit')
  @ApiCookieAuth()
  @ApiOperation({
    summary: 'Delete a withdrawal method that was never used',
    description: 'Only a method NO withdrawal references — 409 otherwise; disable it instead.',
  })
  @ApiOkResponse({ type: DeletedMethodDto })
  @NotClientScoped('Platform payment configuration; names no client and returns no client data.')
  @Audited('withdrawal_method.delete')
  remove(@Req() req: Request & { admin: AuthenticatedAdmin }, @Param('key') key: string) {
    return this.methods.remove(key, req.admin);
  }
}
