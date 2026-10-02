import { Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { WalletService } from '../wallet/wallet.service';
import { CurrenciesService } from '../currencies/currencies.service';
import { EmailService } from '../email/email.service';
import { DRIZZLE_DB } from '../../database/database.module';
import type { Db } from '../../database/db';
import {
  NOTIFICATION_DISPATCH,
  type NotificationDispatchPort,
} from '../../common/provisioning/notification-dispatch.port';
import { PaymentMethodsService } from './payment-methods.service';
import { PaymentProviderRegistry } from './providers/payment-provider-registry';
import { TransfersService } from './transfers.service';
import { TransferExecutor } from './transfer-executor.service';
import { TransactionQueries } from './queries/transaction-queries';
import { TransactionRecords } from './transaction-records';
import { WithdrawalCommands } from './withdrawal-commands';
import { DepositCommands } from './deposit-commands';
import { payerRedirectUrl, providerCallbackUrl } from './core/payer-urls';
import type { TransactionLedgerPort } from './core/payments-ledger.port';

export * from './queries/transaction-queries';
export { MANUAL_ADMIN_PROVIDER, type WithinTransaction } from './transaction-records';
export type { ApproveWithdrawalOptions } from './withdrawal-commands';
export { depositStateOf } from './core/deposit-state';

/**
 * The payments module's one injectable surface over the transaction books.
 *
 * A FACADE: the work lives in four parts — `TransactionQueries` (read models),
 * `WithdrawalCommands`, `DepositCommands`, and the `TransactionRecords` they
 * share — and this class only wires them and forwards. It stays because some
 * twenty callers (controllers, admin, trading, the suite) inject or construct
 * it, and it is what the module binds to the core's `TRANSACTION_LEDGER` port.
 *
 * The constructor is positional in the test suite: APPEND parameters, never
 * insert one, or every one after it silently shifts.
 */
@Injectable()
export class TransactionsService implements TransactionLedgerPort {
  readonly queries: TransactionQueries;
  readonly withdrawals: WithdrawalCommands;
  readonly deposits: DepositCommands;
  private readonly records: TransactionRecords;

  constructor(
    wallets: WalletService,
    @Inject(DRIZZLE_DB) db: Db,
    paymentMethods: PaymentMethodsService,
    currencies: CurrenciesService,
    private readonly providers: PaymentProviderRegistry,
    private readonly config: ConfigService,
    email: EmailService,
    @Inject(NOTIFICATION_DISPATCH) notifications: NotificationDispatchPort,
    transfers: TransfersService,
    transferExecutor: TransferExecutor,
  ) {
    this.records = new TransactionRecords(db, wallets);
    this.queries = new TransactionQueries(db, providers);
    this.withdrawals = new WithdrawalCommands(
      db,
      wallets,
      currencies,
      providers,
      notifications,
      this.records,
    );
    this.deposits = new DepositCommands(
      db,
      wallets,
      paymentMethods,
      currencies,
      providers,
      config,
      email,
      notifications,
      transfers,
      transferExecutor,
      this.records,
    );
  }

  /* ── shared records ─────────────────────────────────────────────────────── */

  getById(...a: Parameters<TransactionRecords['getById']>) {
    return this.records.getById(...a);
  }
  resolveAttention(...a: Parameters<TransactionRecords['resolveAttention']>) {
    return this.records.resolveAttention(...a);
  }

  /* ── reads ──────────────────────────────────────────────────────────────── */

  ownerOf(...a: Parameters<TransactionQueries['ownerOf']>) {
    return this.queries.ownerOf(...a);
  }
  listForAdmin(...a: Parameters<TransactionQueries['listForAdmin']>) {
    return this.queries.listForAdmin(...a);
  }
  listForExport(...a: Parameters<TransactionQueries['listForExport']>) {
    return this.queries.listForExport(...a);
  }
  listForUser(...a: Parameters<TransactionQueries['listForUser']>) {
    return this.queries.listForUser(...a);
  }
  summaryForUser(...a: Parameters<TransactionQueries['summaryForUser']>) {
    return this.queries.summaryForUser(...a);
  }
  listAllForAdmin(...a: Parameters<TransactionQueries['listAllForAdmin']>) {
    return this.queries.listAllForAdmin(...a);
  }
  listAllForExport(...a: Parameters<TransactionQueries['listAllForExport']>) {
    return this.queries.listAllForExport(...a);
  }
  summarizeForAdmin(...a: Parameters<TransactionQueries['summarizeForAdmin']>) {
    return this.queries.summarizeForAdmin(...a);
  }

  /* ── withdrawals ────────────────────────────────────────────────────────── */

  listWithdrawalMethods(...a: Parameters<WithdrawalCommands['listWithdrawalMethods']>) {
    return this.withdrawals.listWithdrawalMethods(...a);
  }
  requestWithdrawal(...a: Parameters<WithdrawalCommands['requestWithdrawal']>) {
    return this.withdrawals.requestWithdrawal(...a);
  }
  approve(...a: Parameters<WithdrawalCommands['approve']>) {
    return this.withdrawals.approve(...a);
  }
  reject(...a: Parameters<WithdrawalCommands['reject']>) {
    return this.withdrawals.reject(...a);
  }
  settle(...a: Parameters<WithdrawalCommands['settle']>) {
    return this.withdrawals.settle(...a);
  }
  markFailed(...a: Parameters<WithdrawalCommands['markFailed']>) {
    return this.withdrawals.markFailed(...a);
  }

  /* ── deposits ───────────────────────────────────────────────────────────── */

  requestDeposit(...a: Parameters<DepositCommands['requestDeposit']>) {
    return this.deposits.requestDeposit(...a);
  }
  hostedPaymentFacts(...a: Parameters<DepositCommands['hostedPaymentFacts']>) {
    return this.deposits.hostedPaymentFacts(...a);
  }
  gatewayDepositState(...a: Parameters<DepositCommands['gatewayDepositState']>) {
    return this.deposits.gatewayDepositState(...a);
  }
  findDepositByReference(...a: Parameters<DepositCommands['findDepositByReference']>) {
    return this.deposits.findDepositByReference(...a);
  }
  approveDeposit(...a: Parameters<DepositCommands['approveDeposit']>) {
    return this.deposits.approveDeposit(...a);
  }
  rejectDeposit(...a: Parameters<DepositCommands['rejectDeposit']>) {
    return this.deposits.rejectDeposit(...a);
  }
  announceDepositAttention(...a: Parameters<DepositCommands['announceDepositAttention']>) {
    this.deposits.announceDepositAttention(...a);
  }
  sendDepositOutcomeEmail(...a: Parameters<DepositCommands['sendDepositOutcomeEmail']>) {
    return this.deposits.sendDepositOutcomeEmail(...a);
  }
  creditDeposit(...a: Parameters<DepositCommands['creditDeposit']>) {
    return this.deposits.creditDeposit(...a);
  }
  chainTransferToAccount(...a: Parameters<DepositCommands['chainTransferToAccount']>) {
    return this.deposits.chainTransferToAccount(...a);
  }

  /* ── where a provider and a payer are sent (core/payer-urls) ────────────── */

  payerRedirectUrl(method: string, reference: string, outcome: 'success' | 'failure') {
    return payerRedirectUrl(this.config, method, reference, outcome);
  }
  providerCallbackUrl(providerCode: string) {
    return providerCallbackUrl(this.providers, this.config, providerCode);
  }
}
