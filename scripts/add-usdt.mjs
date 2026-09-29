/**
 * One-off: add USDT and open a USDT wallet for every existing client.
 *
 * Goes through CurrenciesService.create rather than an INSERT so the row gets
 * the service's own normalisation, sort-order placement, limit assertions and
 * audit entry. Wallet opening is a SEPARATE step on purpose — see
 * WalletProvisioningService: creating a currency deliberately does not write a
 * row per client, so the backfill is only ever run deliberately.
 *
 * Idempotent: re-running reports "already exists" and opens 0 wallets.
 *
 * Usage:  node scripts/add-usdt.mjs
 */
import 'dotenv/config';
import { NestFactory } from '@nestjs/core';
import { AppModule } from '../dist/app.module.js';
import { CurrenciesService } from '../dist/modules/currencies/currencies.service.js';
import { WalletProvisioningService } from '../dist/modules/wallet/wallet-provisioning.service.js';
import { SYSTEM_ACTOR } from '../dist/common/security/actor.js';

const app = await NestFactory.createApplicationContext(AppModule, { logger: ['error'] });
try {
  const currencies = app.get(CurrenciesService);

  const existing = await currencies.findOne('USDT');
  if (existing) {
    process.stdout.write('USDT already exists — leaving it untouched.\n');
  } else {
    const row = await currencies.create(
      {
        code: 'USDT',
        name: 'Tether',
        symbol: 'USDT',
        // 2, matching USD and the original 0027 seed. USDT is quoted against
        // the dollar, so the display precision that suits one suits the other.
        decimals: 2,
        enabled: true,
        // USD keeps the default. Exactly one currency may hold the flag.
        isDefault: false,
        /*
         * Explicit, and mirroring USD. Limits are per currency in its OWN units
         * (migration 0162), and USDT is dollar-quoted, so USD's numbers carry
         * over unchanged. They are not optional: assertLimits runs every field
         * through Decimal, and an omitted one is `new Decimal(undefined)`.
         */
        minDeposit: '10.00000000',
        maxDeposit: '250000.00000000',
        minWithdrawal: '10.00000000',
        maxWithdrawal: '50000.00000000',
        maxWithdrawalDaily: '100000.00000000',
        maxAdminCredit: '50000.00000000',
      },
      SYSTEM_ACTOR,
    );
    process.stdout.write(
      `created ${row.code} (${row.name}) symbol=${row.symbol} decimals=${row.decimals} ` +
        `enabled=${row.enabled} sortOrder=${row.sortOrder}\n`,
    );
  }

  const opened = await app.get(WalletProvisioningService).openWalletForAllClients('USDT');
  process.stdout.write(`USDT wallets opened for existing clients: ${opened}\n`);
} finally {
  await app.close();
}
