import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import { ApiCookieAuth, ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Request } from 'express';
import {
  AuthenticatedAdmin,
  PermissionsGuard,
  RequirePermissions,
} from '../admin/guards/admin.guard';
import { NotClientScoped } from '../admin/guards/client-scope.decorator';
import { Audited } from '../admin/guards/audited.decorator';
import { IbCommissionTypesService } from './ib-commission-types.service';
import {
  CreateIbCommissionTypeDto,
  IbCommissionTypeDto,
  UpdateIbCommissionTypeDto,
} from './dto/ib-commission-type.dto';

/**
 * Commission types — the rate cards products are sold on (0140).
 *
 * Under `admin/ib-…` with the ladder rather than under the product catalogue,
 * because it is about what PARTNERS are paid: a product picks a type, and the
 * levels page decides how a type is split across the tree. The product form
 * only assigns; the numbers live here.
 *
 * ## `ib.commission_types.*` stay separate from `ib.view`
 *
 * An operator trusted to READ the rate cards is not automatically trusted to
 * change what every product pays — the same split the levels make.
 *
 * ## `@NotClientScoped`, and why that is not an oversight
 *
 * Platform configuration: it names no client, returns no client data, and is
 * identical for every admin who can see it.
 */
@ApiTags('admin')
@Controller('admin/ib-commission-types')
export class AdminIbCommissionTypesController {
  constructor(private readonly types: IbCommissionTypesService) {}

  @Get()
  @UseGuards(PermissionsGuard)
  @RequirePermissions('ib.commission_types.view', 'ib.levels.view', 'products.view')
  @ApiCookieAuth()
  @ApiOperation({
    summary: 'Every commission type, disabled ones included',
    description:
      'Each row names the products sold on it, so a delete or a disable can be refused on the ' +
      'screen before the API refuses it.',
  })
  @ApiOkResponse({ type: IbCommissionTypeDto, isArray: true })
  @NotClientScoped('Platform commission configuration; names no client and returns no client data.')
  list() {
    return this.types.listAll();
  }

  @Post()
  @UseGuards(PermissionsGuard)
  @RequirePermissions('ib.commission_types.create')
  @ApiCookieAuth()
  @ApiOperation({
    summary: 'Add a commission type',
    description:
      'Money per standard lot for the partners’ commission and for the client’s rebate. Each ' +
      'level of the ladder takes a percentage of these. Assign it to products on the product ' +
      'form.',
  })
  @ApiOkResponse({ type: IbCommissionTypeDto })
  @NotClientScoped('Platform commission configuration; names no client and returns no client data.')
  @Audited('ib_commission_type.create')
  create(
    @Req() req: Request & { admin: AuthenticatedAdmin },
    @Body() dto: CreateIbCommissionTypeDto,
  ) {
    return this.types.create(dto, req.admin);
  }

  @Patch(':id')
  @UseGuards(PermissionsGuard)
  @RequirePermissions('ib.commission_types.edit')
  @ApiCookieAuth()
  @ApiOperation({
    summary: 'Update a commission type',
    description:
      'Applies to the NEXT trade on every product sold on it. Accruals record the type AND the ' +
      'pool it produced, so nothing already earned is restated. Disabling one that products ' +
      'are sold on is refused: a disabled type stops paying, and those products would keep ' +
      'trading while every partner on them earned nothing.',
  })
  @ApiOkResponse({ type: IbCommissionTypeDto })
  @NotClientScoped('Platform commission configuration; names no client and returns no client data.')
  @Audited('ib_commission_type.update')
  update(
    @Req() req: Request & { admin: AuthenticatedAdmin },
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateIbCommissionTypeDto,
  ) {
    return this.types.update(id, dto, req.admin);
  }

  @Delete(':id')
  @HttpCode(204)
  @UseGuards(PermissionsGuard)
  @RequirePermissions('ib.commission_types.delete')
  @ApiCookieAuth()
  @ApiOperation({
    summary: 'Remove a commission type',
    description:
      'Refuses one that products are sold on, naming them, and one that has ever priced a ' +
      'payout — the record of what was paid has to stay explicable. Disable it instead.',
  })
  @NotClientScoped('Platform commission configuration; names no client and returns no client data.')
  @Audited('ib_commission_type.delete')
  async remove(
    @Req() req: Request & { admin: AuthenticatedAdmin },
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    await this.types.remove(id, req.admin, req.admin.clientScope);
  }
}
