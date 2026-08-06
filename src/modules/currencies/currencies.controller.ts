import { Controller, Get } from '@nestjs/common';
import { ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrenciesService } from './currencies.service';
import { CurrencyDto } from './dto/currency.dto';

/**
 * The currencies a client may hold — the client-facing half.
 *
 * PUBLIC, and that is a deliberate choice rather than an omission.
 *
 * This returns the operator's currency list: codes, names, symbols and display
 * precision. It contains no client data, no balances and nothing that varies by
 * who is asking. Putting a session in front of it would buy nothing — the same
 * list is on the registration screen, which by definition has no session, and
 * on the marketing surface — while costing a 401 on the one screen that most
 * needs to render before anybody has signed in.
 *
 * Disabled currencies are filtered out by the service rather than flagged, so a
 * caller cannot forget to.
 *
 * The ADMIN half is `admin-currencies.controller.ts`, which is where every
 * write lives and where `settings.manage` is required.
 */
@ApiTags('currencies')
@Controller('currencies')
export class CurrenciesController {
  constructor(private readonly currencies: CurrenciesService) {}

  @Get()
  @ApiOperation({
    summary: 'The currencies this platform supports, enabled only, in operator order',
  })
  @ApiOkResponse({ type: CurrencyDto, isArray: true })
  list() {
    return this.currencies.listEnabled();
  }
}
