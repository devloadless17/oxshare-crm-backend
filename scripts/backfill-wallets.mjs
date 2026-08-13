/**
 * Open a wallet in every ENABLED currency, for every existing client.
 *
 * ## When you need this
 *
 * Registration opens a wallet per currency enabled AT THAT MOMENT, and enabling
 * a currency now backfills the clients who came before it — see
 * `CurrenciesService.update`. This script is for the gap between those two: a
 * database whose currencies were enabled BEFORE the backfill existed, where
 * clients are still holding whichever subset was live on the day they signed up.
 *
 * It is a one-off repair, not part of the running system. Once the platform has
 * been through one enable with the backfill in place, it has nothing to do — and
 * says so, because every insert is `ON CONFLICT DO NOTHING`.
 *
 * ## Safe to run at any time
 *
 * Idempotent and non-destructive. `WalletsStore.openForAllClients` adds only the
 * missing rows and never touches an existing balance — the clause is DO NOTHING,
 * not DO UPDATE. Running it twice reports zero the second time.
 *
 * Usage:
 *   node scripts/backfill-wallets.mjs
 */
import 'dotenv/config';
import { NestFactory } from '@nestjs/core';
import { AppModule } from '../dist/app.module.js';
import { WalletProvisioningService } from '../dist/modules/wallet/wallet-provisioning.service.js';
import { CurrenciesService } from '../dist/modules/currencies/currencies.service.js';

const app = await NestFactory.createApplicationContext(AppModule, { logger: ['error'] });
try {
  const provisioning = app.get(WalletProvisioningService);
  const enabled = await app.get(CurrenciesService).listEnabled();

  if (enabled.length === 0) {
    process.stdout.write('No currencies are enabled — nothing to open.\n');
  }

  let total = 0;
  for (const currency of enabled) {
    // Through the SERVICE rather than the store, for its never-throws wrapper:
    // one bad currency should not abandon the rest of the list half-done.
    const opened = await provisioning.openWalletForAllClients(currency.code);
    process.stdout.write(`  ${currency.code.padEnd(5)} +${opened}\n`);
    total += opened;
  }
  process.stdout.write(`total wallets opened: ${total}\n`);
} finally {
  await app.close();
}
