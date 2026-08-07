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
import { PaymentMethodsService } from './payment-methods.service';
import {
  CreatePaymentMethodDto,
  PaymentMethodDto,
  UpdatePaymentMethodDto,
} from './dto/payment-method.dto';

/**
 * How clients can put money in — the operator's side.
 *
 * ## `@NotClientScoped`, and why that is not an oversight
 *
 * Every admin route must declare a client-scope stance and
 * `client-scope-coverage.spec.ts` fails the build on one that declares neither.
 * These are platform configuration: they name no client and return no client
 * data. The deposits made THROUGH a method are client data, and they live on
 * the transactions queue, which is scoped.
 *
 * ## Reads are `payments.view`, writes are `payments.manage`
 *
 * Matching the settings and IB-level splits. A write here changes the account
 * number every client is told to send money to, which is why the two are
 * separate and why every write is audited.
 */
@ApiTags('admin')
@Controller('admin/payment-methods')
export class AdminPaymentMethodsController {
  constructor(private readonly methods: PaymentMethodsService) {}

  @Get()
  @UseGuards(PermissionsGuard)
  @RequirePermissions('payments.view')
  @ApiCookieAuth()
  @ApiOperation({
    summary: 'Every payment method, configured or not',
    description:
      'Includes disabled methods and ones with no pay-to details — managing those is the point ' +
      'of the screen. Clients see a narrower list: GET /payments/methods returns only what is ' +
      'enabled AND configured.',
  })
  @ApiOkResponse({ type: PaymentMethodDto, isArray: true })
  @NotClientScoped('Platform payment configuration; names no client and returns no client data.')
  list() {
    return this.methods.listAll();
  }

  @Post()
  @UseGuards(PermissionsGuard)
  @RequirePermissions('payments.manage')
  @ApiCookieAuth()
  @ApiOperation({
    summary: 'Add a payment method',
    description:
      'A method with no `payTo` is created but never offered to clients — see the service. That ' +
      'is deliberate: an account number nobody has filled in cannot receive money, and inventing ' +
      'one is how money leaves and does not arrive.',
  })
  @ApiOkResponse({ type: PaymentMethodDto })
  @NotClientScoped('Platform payment configuration; names no client and returns no client data.')
  @Audited('payment_method.create')
  create(@Req() req: Request & { admin: AuthenticatedAdmin }, @Body() dto: CreatePaymentMethodDto) {
    return this.methods.create(dto, req.admin.id);
  }

  @Patch(':key')
  @UseGuards(PermissionsGuard)
  @RequirePermissions('payments.manage')
  @ApiCookieAuth()
  @ApiOperation({
    summary: 'Update a payment method',
    description:
      'PATCH, and `key` itself is not editable: it is the primary key and `transactions.' +
      'method_key` references it, so renaming is a data migration rather than an edit.',
  })
  @ApiOkResponse({ type: PaymentMethodDto })
  @NotClientScoped('Platform payment configuration; names no client and returns no client data.')
  @Audited('payment_method.update')
  update(
    @Req() req: Request & { admin: AuthenticatedAdmin },
    @Param('key') key: string,
    @Body() dto: UpdatePaymentMethodDto,
  ) {
    return this.methods.update(key, dto, req.admin.id);
  }

  @Delete(':key')
  @UseGuards(PermissionsGuard)
  @RequirePermissions('payments.manage')
  @ApiCookieAuth()
  @ApiOperation({
    summary: 'Remove a payment method',
    description:
      'Refuses one that any deposit references — disabling is almost always what was meant, and ' +
      'it keeps the history readable while stopping new deposits.',
  })
  @NotClientScoped('Platform payment configuration; names no client and returns no client data.')
  @Audited('payment_method.delete')
  remove(@Param('key') key: string) {
    return this.methods.remove(key);
  }
}
