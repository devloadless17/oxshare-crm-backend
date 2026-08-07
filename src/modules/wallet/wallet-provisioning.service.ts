import { Injectable, Logger } from '@nestjs/common';
import { CurrenciesService } from '../currencies/currencies.service';
import { WalletService, type Executor } from './wallet.service';

/**
 * Opening a client's wallets — the two moments it happens, in one place.
 *
 * ## The two moments, and why they are different
 *
 *   REGISTRATION  a wallet in EVERY enabled currency. Changed from "one, in the
 *                 default currency": a client should see the full set of
 *                 balances the platform offers from their first sign-in, and
 *                 the alternative — opening the rest at KYC approval — meant
 *                 /wallet grew new rows at a moment the client associates with
 *                 identity checks rather than with money.
 *
 *                 The cost, stated: two rows per client today instead of one,
 *                 and enabling a THIRD currency later does not retroactively
 *                 open wallets for existing clients. `getOrCreateWallet` on the
 *                 read and write paths is what covers them, and it is why this
 *                 is safe to leave rather than backfill.
 *
 *   KYC APPROVAL  the same call, run again. Approval is the moment a client is
 *                 cleared to move money, so it is the natural place to catch up
 *                 anyone who registered before a currency was enabled. It adds
 *                 only what is missing.
 *
 * ## Never fatal to the thing that triggered it
 *
 * Neither caller may fail because of this. A registration that 500s after the
 * user row is committed leaves an account the client cannot sign into and
 * cannot re-create — the address is taken. A KYC approval that 500s after the
 * transaction has committed leaves an approved client whose reviewer is told
 * the approval failed, and the natural response is to approve again.
 *
 * So both entry points swallow and LOG. A missing wallet is recoverable at any
 * later moment — `getOrCreateWallet` is idempotent and every money path calls
 * it — while a failed registration or a double approval is not.
 */
@Injectable()
export class WalletProvisioningService {
  private readonly logger = new Logger(WalletProvisioningService.name);

  constructor(
    private readonly wallets: WalletService,
    private readonly currencies: CurrenciesService,
  ) {}

  /**
   * One wallet, in the platform's default currency.
   *
   * NOT the registration path any more — `openAllEnabledWallets` is. Kept
   * because it is the right shape for opening a single wallet on demand, and
   * because deleting it would take the reasoning below with it.
   *
   * Opens NOTHING when no currency is marked default, and says so loudly. The
   * alternative — falling back to a hardcoded 'USD' — would open every new
   * client a wallet in a currency the operator did not choose, and a wallet
   * cannot be deleted once it has a ledger entry. A log line an operator can
   * act on beats a permanent wrong row.
   */
  async openDefaultWallet(userId: string, executor?: Executor): Promise<void> {
    try {
      const currency = await this.currencies.getDefault();
      if (!currency) {
        this.logger.error(
          `No default currency is configured, so no wallet was opened for user ${userId}. ` +
            'Set one in the admin currencies screen; existing clients get theirs on KYC approval.',
        );
        return;
      }
      await this.wallets.getOrCreateWallet(userId, currency.code, executor);
      this.logger.log(`Opened ${currency.code} wallet for new user ${userId}.`);
    } catch (error) {
      // See the class comment: registration must not fail because of this.
      this.logger.error(
        `Could not open the default wallet for user ${userId}: ${String(error)}`,
        error instanceof Error ? error.stack : undefined,
      );
    }
  }

  /**
   * A wallet in every enabled currency. Called on REGISTRATION, and again on
   * KYC approval to catch up anyone who registered before a currency existed.
   *
   * Sequential rather than `Promise.all`, deliberately. Each call is an upsert
   * that takes a row lock, and firing them concurrently against the same user
   * buys nothing — the list is two or three currencies — while making a
   * deadlock between two approvals of different clients possible for no reason.
   *
   * Idempotent throughout: `getOrCreateWallet` conflicts on
   * (user_id, currency), so re-approving, or approving a client who already
   * holds some of these, adds only what is missing.
   */
  async openAllEnabledWallets(userId: string, executor?: Executor): Promise<void> {
    try {
      const enabled = await this.currencies.listEnabled();
      if (enabled.length === 0) {
        this.logger.error(
          `No currencies are enabled, so no wallets were opened for user ${userId}. ` +
            'Enable one in the admin currencies screen; existing clients get theirs on the ' +
            'next money path that touches a wallet.',
        );
        return;
      }

      for (const currency of enabled) {
        await this.wallets.getOrCreateWallet(userId, currency.code, executor);
      }
      this.logger.log(
        `Opened wallets for user ${userId}: ${enabled.map((c) => c.code).join(', ')}.`,
      );
    } catch (error) {
      // See the class comment: neither a registration nor an already-committed
      // approval may be reported as failed because of this.
      this.logger.error(
        `Could not open wallets for user ${userId}: ${String(error)}`,
        error instanceof Error ? error.stack : undefined,
      );
    }
  }
}
