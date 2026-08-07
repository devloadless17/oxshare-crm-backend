import { Body, Controller, Delete, Get, Param, Patch, Post, Res, UseGuards } from '@nestjs/common';
import { ApiCookieAuth, ApiOkResponse, ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';
import { Query } from '@nestjs/common';
import type { Response } from 'express';
import { exportFormat, streamCsvFromArray } from '../../common/export/export-response';
import { NotAudited } from '../admin/guards/audited.decorator';
import { PermissionsGuard, RequirePermissions } from '../admin/guards/admin.guard';
import { NotClientScoped } from '../admin/guards/client-scope.decorator';
import { Audited } from '../admin/guards/audited.decorator';
import { CurrenciesService } from './currencies.service';
import { CreateCurrencyDto, CurrencyDto, UpdateCurrencyDto } from './dto/currency.dto';

/**
 * Currency administration — the operator's control over what money exists.
 *
 * ## Guarded with `settings.*`, not a new permission key
 *
 * A currency is operator configuration of exactly the same class as the
 * platform download links and the brand name, and those are `settings.manage`
 * (`admin-platform-links.controller.ts` records the reasoning: forcing a master
 * admin to edit routine operational content is how the master credential ends
 * up shared). Minting `currencies.manage` would add a key every existing role
 * lacks, so the screen would be invisible to everybody until someone edited
 * roles — a migration disguised as a feature.
 *
 * Reads are `settings.view` and writes are `settings.manage`, matching the
 * general-settings split exactly.
 *
 * ## Every write is audited
 *
 * Disabling a currency stops new wallets platform-wide and changing the default
 * changes what every subsequent registration opens. Neither is destructive, but
 * both are the kind of change somebody needs to be able to attribute later.
 *
 * ## PermissionsGuard, never AdminGuard
 *
 * `AdminGuard` authenticates but does not read `@RequirePermissions`, so pairing
 * the two declares a permission that nothing enforces.
 * `route-authorization.spec.ts` fails the build on exactly that mistake.
 */
@ApiTags('admin')
@Controller('admin/currencies')
export class AdminCurrenciesController {
  constructor(private readonly currencies: CurrenciesService) {}

  @Get()
  @UseGuards(PermissionsGuard)
  @RequirePermissions('settings.view')
  @ApiCookieAuth()
  @ApiOperation({
    summary: 'Every currency, including disabled ones, in operator order',
    description:
      'Unlike the client-facing GET /currencies, this includes disabled currencies — managing ' +
      'them is the point of the screen.',
  })
  @ApiOkResponse({ type: CurrencyDto, isArray: true })
  @NotClientScoped('Operator configuration; contains no client data.')
  list() {
    return this.currencies.listAll();
  }

  /**
   * Every currency as CSV.
   *
   * `settings.view` — the same read permission the list carries, and not the
   * `settings.manage` the writes need: an export is a read.
   */
  @Get('export')
  @UseGuards(PermissionsGuard)
  @RequirePermissions('settings.view')
  @ApiCookieAuth()
  @ApiOperation({ summary: 'Export every currency as CSV, including disabled ones' })
  @ApiOkResponse({
    description: 'A CSV file, named `currencies-<YYYY-MM-DD>.csv`.',
    content: { 'text/csv': { schema: { type: 'string', format: 'binary' } } },
  })
  @ApiQuery({ name: 'format', required: false, enum: ['csv'] })
  @NotClientScoped('Operator configuration; contains no client data.')
  /*
   * NOT audited, unlike the client, KYC, withdrawal and partner exports.
   *
   * Those carry client PII or money and are worth being able to attribute
   * months later. A currency list is the same information the platform shows on
   * its registration screen — recording every download of it would fill the log
   * with rows nobody searches for, and make the exports that DO matter harder
   * to find among them.
   */
  @NotAudited(
    'Operator configuration containing no client data — the same list the signed-out registration screen reads. Auditing it would bury the PII exports that are worth attributing.',
  )
  async exportCurrencies(@Res() res: Response, @Query('format') format?: string) {
    const chosen = exportFormat(format);
    await streamCsvFromArray(res, 'currencies', chosen, CURRENCY_EXPORT_COLUMNS, async () =>
      this.currencies.listAll(),
    );
  }

  @Post()
  @UseGuards(PermissionsGuard)
  @RequirePermissions('settings.manage')
  @ApiCookieAuth()
  @ApiOperation({
    summary: 'Add a currency',
    description:
      'The code is normalised to upper case and must be unique. Marking it default moves the ' +
      'flag off whatever holds it, atomically.',
  })
  @ApiOkResponse({ type: CurrencyDto })
  @NotClientScoped('Operator configuration; contains no client data.')
  @Audited('currency.create')
  create(@Body() dto: CreateCurrencyDto) {
    return this.currencies.create(dto);
  }

  @Patch(':code')
  @UseGuards(PermissionsGuard)
  @RequirePermissions('settings.manage')
  @ApiCookieAuth()
  @ApiOperation({
    summary: 'Update a currency',
    description:
      'PATCH, not PUT: the code is the primary key and is referenced by wallets, transactions ' +
      'and transfers, so it is not editable — a rename would be a data migration across four ' +
      'money tables. Everything else is optional and only supplied fields change.',
  })
  @ApiOkResponse({ type: CurrencyDto })
  @NotClientScoped('Operator configuration; contains no client data.')
  @Audited('currency.update')
  update(@Param('code') code: string, @Body() dto: UpdateCurrencyDto) {
    return this.currencies.update(code, dto);
  }

  @Delete(':code')
  @UseGuards(PermissionsGuard)
  @RequirePermissions('settings.manage')
  @ApiCookieAuth()
  @ApiOperation({
    summary: 'Delete a currency that nobody holds',
    description:
      'Refuses with 409 if any wallet exists in it — balances and append-only ledger history ' +
      'depend on the row. Disable it instead: that stops new wallets while keeping the existing ' +
      'ones readable and spendable.',
  })
  @NotClientScoped('Operator configuration; contains no client data.')
  @Audited('currency.delete')
  remove(@Param('code') code: string) {
    return this.currencies.remove(code);
  }
}

/**
 * The currency export's columns.
 *
 * `decimals` is a DISPLAY precision — how many places the UI shows — and is a
 * genuine integer column, not a monetary value. There is no money on this
 * table at all.
 */
const CURRENCY_EXPORT_COLUMNS = [
  { header: 'Code', value: (r: CurrencyExportRow) => r.code },
  { header: 'Name', value: (r: CurrencyExportRow) => r.name },
  { header: 'Symbol', value: (r: CurrencyExportRow) => r.symbol },
  { header: 'Display decimals', value: (r: CurrencyExportRow) => r.decimals },
  { header: 'Enabled', value: (r: CurrencyExportRow) => r.enabled },
  { header: 'Default', value: (r: CurrencyExportRow) => r.isDefault },
  { header: 'Sort order', value: (r: CurrencyExportRow) => r.sortOrder },
  { header: 'Created at', value: (r: CurrencyExportRow) => r.createdAt },
] as const;

interface CurrencyExportRow {
  code: string;
  name: string;
  symbol: string;
  decimals: number;
  enabled: boolean;
  isDefault: boolean;
  sortOrder: number;
  createdAt: Date;
}
