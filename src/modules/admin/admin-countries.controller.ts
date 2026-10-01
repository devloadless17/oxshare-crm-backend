import { Body, Controller, Get, Put, Req, UseGuards } from '@nestjs/common';
import { ApiCookieAuth, ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Request } from 'express';
import { AuthenticatedAdmin, PermissionsGuard, RequirePermissions } from './guards/admin.guard';
import { NotClientScoped } from './guards/client-scope.decorator';
import { Audited } from './guards/audited.decorator';
import { AdminCountriesService } from './admin-countries.service';
import { OfferedCountriesDto, SetOfferedCountriesDto } from './dto/countries.dto';

const NOT_SCOPED = 'Platform configuration: the countries offered. Names no client.';

/**
 * The countries the broker offers (0178): edited in the KYC builder, read by
 * the payment-method dialogs for their country rules.
 */
@ApiTags('admin')
@Controller('admin/countries')
export class AdminCountriesController {
  constructor(private readonly countries: AdminCountriesService) {}

  @Get()
  @UseGuards(PermissionsGuard)
  @RequirePermissions('kyc.view', 'kyc.edit', 'payments.view', 'payments.edit')
  @ApiCookieAuth()
  @ApiOperation({ summary: 'The countries offered, and every country that could be' })
  @ApiOkResponse({ type: OfferedCountriesDto })
  @NotClientScoped(NOT_SCOPED)
  get() {
    return this.countries.get();
  }

  @Put()
  @UseGuards(PermissionsGuard)
  @RequirePermissions('kyc.edit')
  @ApiCookieAuth()
  @ApiOperation({
    summary: 'Choose the countries offered',
    description:
      'Sign-up, KYC, the desk and payment-method rules all follow this list. A client keeps a ' +
      'country they already hold; only new choices are limited to it.',
  })
  @ApiOkResponse({ type: OfferedCountriesDto })
  @NotClientScoped(NOT_SCOPED)
  @Audited('kyc.countries_update')
  set(@Body() dto: SetOfferedCountriesDto, @Req() req: Request & { admin: AuthenticatedAdmin }) {
    return this.countries.set(dto.codes, req.admin.id);
  }
}
