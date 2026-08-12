import { Module } from '@nestjs/common';
import { AdminAuthModule } from '../admin/admin-auth.module';
import { TradingModule } from '../trading/trading.module';
import { AdminCatalogueController } from './admin-catalogue.controller';
import { CatalogueService } from './catalogue.service';

/**
 * Products, their MT5 groups, and the agencies (وكالة) that sell them.
 *
 * `TradingModule` is imported for one reason: `Mt5AccountsService.
 * listGroupsForClients()`, which is how attaching a group VALIDATES that the
 * group exists on the broker's server and reads back its currency. That check
 * is the point of the screen, so the dependency is deliberate rather than
 * incidental.
 *
 * The direction matters and is acyclic: this module depends on trading, and
 * trading reads the catalogue through the `@Global()` `ProductsStore` rather
 * than through this module. `SelfServiceGroups` therefore resolves a client's
 * offer without importing anything from here.
 *
 * `CatalogueService` is exported for the IB module, which needs to name an
 * agency when a partner is appointed to one.
 */
@Module({
  imports: [AdminAuthModule, TradingModule],
  controllers: [AdminCatalogueController],
  providers: [CatalogueService],
  exports: [CatalogueService],
})
export class ProductsModule {}
