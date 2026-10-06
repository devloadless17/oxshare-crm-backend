import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Put,
  Req,
  UseGuards,
} from '@nestjs/common';
import { ApiCookieAuth, ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Request } from 'express';
import { Admin } from '../../store/admins.store';
import { PermissionsGuard, RequirePermissions } from '../admin/guards/admin.guard';
import { NotClientScoped } from '../admin/guards/client-scope.decorator';
import { Audited } from '../admin/guards/audited.decorator';
import { CatalogueService } from './catalogue.service';
import {
  AgencyDto,
  AttachGroupDto,
  AvailableGroupDto,
  ProductDto,
  SetAgencyProductsDto,
  UpdateProductGroupDto,
  UpsertAgencyDto,
  UpsertProductDto,
} from './dto/catalogue.dto';

/**
 * The catalogue, from the back office: products, their MT5 groups, and the
 * agencies (وكالة) that sell them.
 *
 * ## `settings.view` / `settings.edit`, not a new permission pair
 *
 * These are the same class as the platform download links and the trading
 * terms: commercial configuration an operator sets and revisits rarely. Minting
 * `products.edit` and `agencies.edit` would mean a migration granting them to
 * everyone who already holds `settings.edit` — and the last time this codebase
 * added catalogue keys without that migration, every role edit failed with
 * "you cannot grant permissions you do not hold".
 *
 * Appointing a partner to an agency is NOT here. That happens on approval and
 * is `ib.approve`, because deciding who becomes a partner and deciding what a
 * programme contains are different powers.
 *
 * ## `@NotClientScoped` throughout
 *
 * Every route names no client and returns no client data. What it returns is
 * identical for every admin who can see it.
 */
@ApiTags('admin')
@Controller('admin')
export class AdminCatalogueController {
  constructor(private readonly catalogue: CatalogueService) {}

  /* ── Products ─────────────────────────────────────────────────────────── */

  @Get('products')
  @UseGuards(PermissionsGuard)
  @RequirePermissions('settings.view')
  @ApiCookieAuth()
  @ApiOperation({
    summary: 'Every product, with the MT5 groups behind it',
    description:
      'A product with no groups cannot be opened by anybody — it is a name waiting for a group. ' +
      'Ordered by sortOrder then name, which is the order clients see.',
  })
  @ApiOkResponse({ type: [ProductDto] })
  @NotClientScoped('The product catalogue; contains no client data.')
  listProducts() {
    return this.catalogue.listProducts();
  }

  @Get('products/mt5-groups')
  @UseGuards(PermissionsGuard)
  @RequirePermissions('settings.edit')
  @ApiCookieAuth()
  @ApiOperation({
    summary: 'MT5 groups available to attach, read live where possible',
    description:
      'Gated on settings.edit rather than trading.create, unlike GET /admin/mt5/groups. The two ' +
      'read the same list for different jobs: that one is for opening an account, this one is ' +
      'for building the catalogue, and an operator who configures products has no reason to hold ' +
      'the power to open accounts.\n\n' +
      'Groups another product already claims come back flagged rather than filtered out — "the ' +
      'broker does not offer it" and "ECN already has it" are different problems.\n\n' +
      'When MT5 cannot be reached this falls back to the synced catalogue rather than failing, ' +
      'and every row carries `lastSeenAt` saying when it was last confirmed. Attaching a group ' +
      'still validates against the live server, so a stale row here cannot become a stored ' +
      'product configuration.',
  })
  @ApiOkResponse({ type: [AvailableGroupDto] })
  @NotClientScoped('MT5 server configuration; contains no client data.')
  availableGroups() {
    return this.catalogue.availableGroups();
  }

  @Post('products')
  @UseGuards(PermissionsGuard)
  @RequirePermissions('settings.edit')
  @ApiCookieAuth()
  @ApiOperation({ summary: 'Create a product' })
  @ApiOkResponse({ type: ProductDto })
  @NotClientScoped('The product catalogue; contains no client data.')
  @Audited('product.create')
  createProduct(@Body() dto: UpsertProductDto, @Req() req: Request & { admin: Admin }) {
    return this.catalogue.createProduct(dto, req.admin);
  }

  @Put('products/:id')
  @UseGuards(PermissionsGuard)
  @RequirePermissions('settings.edit')
  @ApiCookieAuth()
  @ApiOperation({
    summary: 'Update a product',
    description:
      'Disabling stops it being offered and leaves every open account trading, the same rule a ' +
      'disabled currency follows.',
  })
  @ApiOkResponse({ type: ProductDto })
  @NotClientScoped('The product catalogue; contains no client data.')
  @Audited('product.update')
  updateProduct(
    @Param('id') id: string,
    @Body() dto: UpsertProductDto,
    @Req() req: Request & { admin: Admin },
  ) {
    return this.catalogue.updateProduct(id, dto, req.admin);
  }

  @Delete('products/:id')
  @UseGuards(PermissionsGuard)
  @RequirePermissions('settings.edit')
  @ApiCookieAuth()
  @ApiOperation({
    summary: 'Delete a product',
    description:
      'Refused while an agency still sells it, naming the agencies. Disabling is almost always ' +
      'what is wanted instead.',
  })
  @NotClientScoped('The product catalogue; contains no client data.')
  @Audited('product.delete')
  async deleteProduct(@Param('id') id: string, @Req() req: Request & { admin: Admin }) {
    await this.catalogue.deleteProduct(id, req.admin);
  }

  @Post('products/:id/groups')
  @UseGuards(PermissionsGuard)
  @RequirePermissions('settings.edit')
  @ApiCookieAuth()
  @ApiOperation({
    summary: 'Attach an MT5 group to a product',
    description:
      'The group must exist on the server — the bridge is asked, and the same call supplies the ' +
      'currency, so a typo is refused here rather than at a client’s first account open. A group ' +
      'may back only one product.',
  })
  @ApiOkResponse({ type: ProductDto })
  @NotClientScoped('The product catalogue; contains no client data.')
  @Audited('product.group_attach')
  attachGroup(
    @Param('id') id: string,
    @Body() dto: AttachGroupDto,
    @Req() req: Request & { admin: Admin },
  ) {
    return this.catalogue.attachGroup(id, dto, req.admin);
  }

  @Patch('products/:id/groups/:groupId')
  @UseGuards(PermissionsGuard)
  @RequirePermissions('settings.edit')
  @ApiCookieAuth()
  @ApiOperation({
    summary: "Set an attached group's minimum deposit",
    description:
      'The least a client may move into an account on this group per transfer, in the ' +
      "group's currency; null clears it. Live groups only. Applies to the next transfer.",
  })
  @ApiOkResponse({ type: ProductDto })
  @NotClientScoped('The product catalogue; contains no client data.')
  @Audited('product.group_update')
  updateGroup(
    @Param('id') id: string,
    @Param('groupId') groupId: string,
    @Body() dto: UpdateProductGroupDto,
    @Req() req: Request & { admin: Admin },
  ) {
    return this.catalogue.updateGroup(id, groupId, dto, req.admin);
  }

  @Delete('products/:id/groups/:groupId')
  @UseGuards(PermissionsGuard)
  @RequirePermissions('settings.edit')
  @ApiCookieAuth()
  @ApiOperation({
    summary: 'Detach an MT5 group from a product',
    description:
      'Accounts already in that group keep trading. The catalogue says what may be sold, not ' +
      'what exists.',
  })
  @ApiOkResponse({ type: ProductDto })
  @NotClientScoped('The product catalogue; contains no client data.')
  @Audited('product.group_detach')
  detachGroup(
    @Param('id') id: string,
    @Param('groupId') groupId: string,
    @Req() req: Request & { admin: Admin },
  ) {
    return this.catalogue.detachGroup(id, groupId, req.admin);
  }

  /* ── Agencies ─────────────────────────────────────────────────────────── */

  @Get('agencies')
  @UseGuards(PermissionsGuard)
  @RequirePermissions('settings.view')
  @ApiCookieAuth()
  @ApiOperation({
    summary: 'Every agency (وكالة), with the products it sells',
    description:
      'A partner is appointed under one agency, and their clients may open that agency’s ' +
      'products and nothing else.',
  })
  @ApiOkResponse({ type: [AgencyDto] })
  @NotClientScoped('Partner programmes; contains no client data.')
  listAgencies() {
    return this.catalogue.listAgencies();
  }

  @Post('agencies')
  @UseGuards(PermissionsGuard)
  @RequirePermissions('settings.edit')
  @ApiCookieAuth()
  @ApiOperation({ summary: 'Create an agency' })
  @ApiOkResponse({ type: AgencyDto })
  @NotClientScoped('Partner programmes; contains no client data.')
  @Audited('agency.create')
  createAgency(@Body() dto: UpsertAgencyDto, @Req() req: Request & { admin: Admin }) {
    return this.catalogue.createAgency(dto, req.admin);
  }

  @Put('agencies/:id')
  @UseGuards(PermissionsGuard)
  @RequirePermissions('settings.edit')
  @ApiCookieAuth()
  @ApiOperation({
    summary: 'Update an agency',
    description: 'Disabling closes it to new applications and leaves its partners appointed.',
  })
  @ApiOkResponse({ type: AgencyDto })
  @NotClientScoped('Partner programmes; contains no client data.')
  @Audited('agency.update')
  updateAgency(
    @Param('id') id: string,
    @Body() dto: UpsertAgencyDto,
    @Req() req: Request & { admin: Admin },
  ) {
    return this.catalogue.updateAgency(id, dto, req.admin);
  }

  @Delete('agencies/:id')
  @UseGuards(PermissionsGuard)
  @RequirePermissions('settings.edit')
  @ApiCookieAuth()
  @ApiOperation({
    summary: 'Delete an agency',
    description: 'Refused while partners are appointed under it.',
  })
  @NotClientScoped('Partner programmes; contains no client data.')
  @Audited('agency.delete')
  async deleteAgency(@Param('id') id: string, @Req() req: Request & { admin: Admin }) {
    await this.catalogue.deleteAgency(id, req.admin);
  }

  @Put('agencies/:id/products')
  @UseGuards(PermissionsGuard)
  @RequirePermissions('settings.edit')
  @ApiCookieAuth()
  @ApiOperation({
    summary: 'Set the products an agency sells',
    description:
      'The COMPLETE set, not a delta. This is the most consequential write here — it changes ' +
      'what every client under every partner on this agency may open — so the audit entry ' +
      'records the product names before and after, not their ids.',
  })
  @ApiOkResponse({ type: AgencyDto })
  @NotClientScoped('Partner programmes; contains no client data.')
  @Audited('agency.products_set')
  setAgencyProducts(
    @Param('id') id: string,
    @Body() dto: SetAgencyProductsDto,
    @Req() req: Request & { admin: Admin },
  ) {
    return this.catalogue.setAgencyProducts(id, dto.productIds, req.admin);
  }
}
