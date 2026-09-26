import { Injectable, Logger } from '@nestjs/common';
import { WalletsStore } from '../../store/wallets.store';
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
 *   A SCRIPT      a wallet in ONE currency, for every existing client —
 *                 `openWalletForAllClients`, reached only from
 *                 `scripts/backfill-wallets.mjs`.
 *
 * ## Enabling a currency does NOT open wallets, and that was decided twice
 *
 * `CurrenciesService` called `openWalletForAllClients` on create and on enable
 * for exactly one commit. The argument for it still holds on its own terms: the
 * wallet SCREEN lists what exists rather than what is offered, so a client who
 * registered when only USD and USDT were live sees those two for as long as they
 * never transact in anything else, while the currency screen says six are
 * offered.
 *
 * It was removed at the operator's request, and the cost is why: adding one
 * currency wrote a row per client — tens of thousands here — inside the request
 * that saved the form. A configuration change should not be a bulk write against
 * the money tables. So the operation stayed and its TRIGGER went: an operator
 * runs the script when they mean to, and nothing happens by side effect.
 *
 * Worth recording, because the comment here once claimed otherwise: the
 * KYC-APPROVAL catch-up this block used to name as the safety net WAS NEVER
 * WIRED. `KycService.approve` does not touch wallets and never has. Lazy
 * creation through `getOrCreateWallet` on the money paths is the real fallback,
 * and it is a real one — it just does not cover the list screen.
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
    /*
     * The set-based backfill, shared with `CurrenciesService`.
     *
     * In the store rather than here because those two cannot reach each other —
     * `WalletModule` imports `CurrenciesModule`, and closing that loop hangs
     * Nest's bootstrap rather than failing. See the foot of
     * `wallet-provisioning.port.ts`.
     *
     * APPENDED LAST: this class is constructed positionally in its own spec, so
     * a new parameter in the middle would silently rebind the two above.
     */
    private readonly walletsStore: WalletsStore,
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
      await this.wallets.getOrCreateWallet(userId, currency.code, 'main', executor);
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
        await this.wallets.getOrCreateWallet(userId, currency.code, 'main', executor);
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

  /**
   * A partner's COMMISSION wallet, opened at approval.
   *
   * ## Why at approval rather than at first payout
   *
   * `WalletService.post` opens it lazily on the first confirmed accrual, so this
   * is not what makes commission work — it is what makes the partner SCREEN
   * work on day one. Without it a newly approved partner opens /partner and
   * finds a placeholder where their commission card will eventually be, which
   * reads as an unfinished feature rather than as an empty balance.
   *
   * The lazy path stays and is still the real guarantee: it covers partners
   * approved before this existed, and it covers a commission arriving in a
   * currency this never opened.
   *
   * ## The DEFAULT currency only, not every enabled one
   *
   * Registration opens a wallet in every enabled currency because a client can
   * deposit in any of them. A partner cannot choose what they earn in — the
   * accrual takes the currency of the trade that produced it — so opening one
   * per currency would put a row of empty commission cards in front of somebody
   * who will only ever be paid in one. The rest arrive lazily, if they arrive.
   *
   * ## What this does NOT change
   *
   * The wallet is opened EMPTY, and an empty wallet is a true zero rather than a
   * missing one: the partner has been paid nothing yet, and the screen says so
   * through the earnings total and the engine notice beside it. This does not
   * credit anything, and it must not — a balance nobody earned is the one thing
   * the whole commission separation exists to make impossible.
   */
  async openCommissionWallet(userId: string, executor?: Executor): Promise<void> {
    try {
      const currency = await this.currencies.getDefault();
      if (!currency) {
        this.logger.error(
          `No default currency is configured, so no commission wallet was opened for partner ` +
            `${userId}. It will be opened by their first confirmed commission instead.`,
        );
        return;
      }
      await this.wallets.getOrCreateWallet(userId, currency.code, 'commission', executor);
      this.logger.log(`Opened ${currency.code} commission wallet for partner ${userId}.`);
    } catch (error) {
      /*
       * Swallowed and logged, like every other method here, and the reason is
       * the same shape: by the time this runs the approval has COMMITTED. A
       * reviewer told the approval failed would approve again, which conflicts
       * and changes nothing — while the wallet this failed to open costs
       * nothing, because the first commission opens it anyway.
       */
      this.logger.error(
        `Could not open the commission wallet for partner ${userId}: ${String(error)}`,
        error instanceof Error ? error.stack : undefined,
      );
    }
  }

  /**
   * One currency, opened for every existing client. Returns how many were added.
   *
   * ## ONE STATEMENT, not a loop over clients
   *
   * `openAllEnabledWallets` loops because it runs for a single user over a
   * handful of currencies. This runs for a single currency over EVERY user, and
   * the same shape would be one round trip per client — hundreds of thousands on
   * a real platform, inside an admin request that has already committed.
   *
   * `INSERT … SELECT … ON CONFLICT DO NOTHING` is the same idempotence
   * `getOrCreateWallet` relies on, expressed set-wise: it adds exactly the
   * missing rows, takes no row locks on wallets that already exist, and is safe
   * to run twice.
   *
   * ## Every user, with no status filter, and that is deliberate
   *
   * Not just active clients. A suspended or unverified client still has a wallet
   * list, and giving them the row now is what stops the same gap reappearing the
   * day they are reinstated — the balance is zero and a zero wallet grants
   * nothing. Filtering here would trade a harmless row for a second backfill
   * nobody remembers to run.
   */
  async openWalletForAllClients(currency: string): Promise<number> {
    try {
      const count = await this.walletsStore.openForAllClients(currency);
      this.logger.log(`Backfilled ${count} ${currency} wallet(s) for existing clients.`);
      return count;
    } catch (error) {
      /*
       * Swallowed and logged, like the two above and for the same reason: the
       * currency update that triggered this is already committed. Telling the
       * operator their enable FAILED would invite them to do it again, which
       * changes nothing and backfills nothing — the currency is already enabled.
       * A log line names the currency, and re-enabling is not the repair.
       */
      this.logger.error(
        `Could not backfill ${currency} wallets: ${String(error)}`,
        error instanceof Error ? error.stack : undefined,
      );
      return 0;
    }
  }
}
