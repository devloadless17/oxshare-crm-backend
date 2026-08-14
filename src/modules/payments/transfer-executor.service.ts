import { Inject, Injectable, Logger } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import { DRIZZLE_DB } from '../../database/database.module';
import type { Db } from '../../database/db';
import { tradingAccounts } from '../../database/schema';
import { TransfersService } from './transfers.service';
import { Mt5BridgeClient } from '../trading/mt5/mt5-bridge.client';
import { ValidationError } from '../../common/errors/domain-errors';

/**
 * Carries a pending transfer across to MT5, then settles or fails it.
 *
 * ## The leg that did not exist
 *
 * `TransfersService` moves the CRM's two balances and nothing else. Its own
 * comment on `settle` says why: there was no bridge, so the MT5 side was a
 * write to `trading_accounts.balance` — a number we owned because nothing else
 * did. Nothing in the application ever called `settle`, so every transfer a
 * client requested sat `pending` for ever.
 *
 * This is the missing middle. The order is fixed and the reason is the same one
 * that governs account creation:
 *
 *     MT5 first, our ledger second.
 *
 * If MT5 succeeds and our settle fails, the money is on the trading account and
 * the transfer is still `pending` — visible, reconcilable, and safe to finish
 * by hand. If our ledger moved first and MT5 then refused, the client's wallet
 * would be short with nothing on the other side, which is the version that
 * loses money rather than merely looking wrong.
 *
 * ## The idempotency key is the transfer id
 *
 * Not a fresh UUID. `Mt5BridgeClient.balance` documents this: the key must be
 * stable across retries of the same LOGICAL operation, and a transfer is
 * exactly that — one client intent, one row, one movement, however many times
 * the call is retried after a timeout. `settle` refuses a non-pending transfer,
 * so the CRM side is idempotent too and the pair cannot double-apply.
 */
@Injectable()
export class TransferExecutor {
  private readonly logger = new Logger(TransferExecutor.name);

  constructor(
    @Inject(DRIZZLE_DB) private readonly db: Db,
    private readonly transfers: TransfersService,
    private readonly bridge: Mt5BridgeClient,
  ) {}

  /**
   * Execute one pending transfer end to end.
   *
   * @returns the transfer in its final state — settled, or failed with a reason.
   */
  async execute(transferId: string) {
    const transfer = await this.transfers.findById(transferId);
    if (!transfer) throw new ValidationError('Transfer not found.');
    if (transfer.state !== 'pending') {
      // Not an error. A retried request, or two tabs — the answer is the same
      // row in the same state, which is what idempotent means here.
      return transfer;
    }

    const [account] = await this.db
      .select({ login: tradingAccounts.login })
      .from(tradingAccounts)
      .where(eq(tradingAccounts.id, transfer.tradingAccountId))
      .limit(1);

    if (!account?.login) {
      /*
       * Failed rather than left pending. An account with no MT5 login cannot
       * receive money and never will without somebody intervening, so holding
       * the client's funds against it indefinitely is worse than returning them
       * — `fail` releases the hold and puts the client back exactly where they
       * started.
       */
      await this.transfers.fail(transferId, 'The trading account has no MT5 login.');
      return await this.transfers.findById(transferId);
    }

    if (!this.bridge.isConfigured) {
      /*
       * LEFT PENDING, deliberately — the opposite choice from the branch above.
       *
       * An unconfigured bridge is a deployment problem that will be fixed in
       * minutes, and the transfer is perfectly valid. Failing it would return
       * money the client asked to move and make them ask again; pending is
       * recoverable by running this once the bridge is up.
       */
      this.logger.warn(
        `Transfer ${transferId} left pending: the MT5 bridge is not configured on this deployment`,
      );
      return transfer;
    }

    /*
     * The SIGN follows the direction, and MT5 only ever sees one account.
     *
     * `wallet_to_account` credits MT5, `account_to_wallet` debits it. The wallet
     * leg is the CRM's and is handled by `settle`; the bridge is told about the
     * trading account alone.
     */
    const credit = transfer.direction === 'wallet_to_account';
    const amount = credit ? transfer.amount : `-${transfer.amount}`;

    try {
      const result = await this.bridge.balance({
        login: account.login,
        amount,
        type: 'balance',
        comment: `CRM transfer ${transfer.id}`,
        // Stable across retries — see the class note.
        idempotencyKey: transfer.id,
      });

      this.logger.log(
        `Transfer ${transferId} moved ${amount} on MT5 ${account.login} ` +
          `(deal ${result.dealId}${result.replayed ? ', replayed' : ''}); settling`,
      );
    } catch (error) {
      /*
       * A TIMEOUT is not a failure and must not be treated as one.
       *
       * `Mt5BridgeClient` documents it: the deal may well have been posted and
       * only the response lost. Failing the transfer here would release the
       * hold while the money is already on the trading account — the client
       * would hold it twice. Left pending, the stable idempotency key makes a
       * later retry safe and the bridge returns the SAME deal id rather than
       * moving money again.
       */
      const message = error instanceof Error ? error.message : String(error);
      if (isIndeterminate(message)) {
        this.logger.error(
          `Transfer ${transferId} is INDETERMINATE on MT5 (${message}). Left pending — retry ` +
            'is safe, the idempotency key is the transfer id',
        );
        return transfer;
      }

      await this.transfers.fail(transferId, `MT5 refused the movement: ${message}`);
      this.logger.warn(`Transfer ${transferId} failed on MT5: ${message}`);
      return await this.transfers.findById(transferId);
    }

    await this.transfers.settle(transferId);
    return await this.transfers.findById(transferId);
  }
}

/**
 * "Did we fail to reach a verdict" rather than "did the server say no".
 *
 * The distinction decides whether a client's money is released or held, so it
 * errs toward HELD: an unrecognised error leaves the transfer pending, which is
 * recoverable, instead of releasing a hold against money MT5 may already have
 * moved, which is not.
 *
 * ## It used to say that and do the opposite
 *
 * This listed the network errors and returned false for everything else — and
 * the caller FAILS on false. So an unrecognised error released the hold, which
 * is exactly the behaviour the paragraph above promises it avoids. The comment
 * was right and the code was inverted.
 *
 * It cost real money in this deployment. Restarting the bridge mid-operation
 * leaves its idempotency key claimed with no recorded outcome, so every later
 * attempt is answered:
 *
 *     409 · "This idempotency key is already in flight or was interrupted
 *            mid-operation. Check the MT5 deal history for this login before
 *            retrying."
 *
 * That sentence IS the definition of indeterminate — the deal may have posted.
 * It matched none of the network patterns, so two transfers were marked failed
 * and their holds released while MT5 may already have credited the account.
 *
 * ## So the list is inverted: name what is DETERMINATE
 *
 * A refusal only counts when the bridge rejected the request before MT5 could
 * act on it — a 400, or a validation error raised on our side of the wire.
 * Everything else, known or not, is held. A transfer stuck pending is a row an
 * operator can finish; a hold released against money that moved is a client
 * holding the same funds twice, and nothing in the system will notice.
 */
function isIndeterminate(message: string): boolean {
  return !isDefiniteRefusal(message);
}

/**
 * The narrow set where MT5 provably did NOT act.
 *
 * `400` is the bridge's own validation — a malformed amount, a login it will not
 * accept — raised before it calls MT5 at all. `ValidationError` is ours, raised
 * before the request leaves this process.
 *
 * Note what is NOT here: 409 (the key was claimed, outcome unknown), 500 (the
 * bridge failed somewhere unspecified), and every timeout. Adding a status to
 * this list is a decision to release a client's hold on the strength of it, and
 * it needs the same evidence: that MT5 cannot have moved the money.
 */
function isDefiniteRefusal(message: string): boolean {
  return /\b400\b|validation|invalid|malformed/i.test(message);
}
