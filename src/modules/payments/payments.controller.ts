import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Query,
  Req,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import {
  ApiCookieAuth,
  ApiCreatedResponse,
  ApiHeader,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import {
  IDEMPOTENCY_HEADER,
  Idempotent,
  IdempotencyInterceptor,
} from '../../common/security/idempotency.interceptor';
import { Request } from 'express';
import { JwtAuthGuard } from '../identity/guards/jwt-auth.guard';
import { EmailVerifiedGuard } from '../identity/guards/email-verified.guard';
import { KycVerifiedGuard } from '../identity/guards/kyc-verified.guard';
import { User } from '../../store/users.store';
import { TransactionsService } from './transactions.service';
import { RequestWithdrawalDto, TransactionDto, WithdrawalMethodDto } from './dto/withdrawal.dto';
import { DepositRequestDto, RequestDepositDto } from './dto/deposit.dto';
import { ListTransactionsQueryDto, TransactionPageDto } from './dto/transaction-query.dto';
import { TransfersService } from './transfers.service';
import { TransferExecutor } from './transfer-executor.service';
import { PaymentMethodsService } from './payment-methods.service';
import { PaymentMethodDto } from './dto/payment-method.dto';
import { RequestTransferDto, TransferDto } from './dto/transfer.dto';

/*
 * ── Who may reach what ───────────────────────────────────────────────────────
 *
 * At class level: authenticated, with a verified email address. That is the
 * floor for every route here.
 *
 * `KycVerifiedGuard` is added PER ROUTE rather than to the class, because the
 * two GETs are deliberately outside it. A client may always read their own
 * balance and their own history — refusing that would hide a client's money
 * from them because their documents are still in review, which is a support
 * ticket rather than a control. Only MOVEMENT is gated.
 *
 * Each gated route's service re-checks the level itself. That duplication is
 * deliberate (R-4.3): a service is reachable from a job or a callback, neither
 * of which passes through a guard.
 */
@ApiTags('payments')
@UseGuards(JwtAuthGuard, EmailVerifiedGuard)
@UseInterceptors(IdempotencyInterceptor)
@Controller('payments')
export class PaymentsController {
  constructor(
    private readonly transactions: TransactionsService,
    private readonly paymentMethods: PaymentMethodsService,
    /*
     * `WithdrawalOtpService`, `SecuritySettingsService` and `EmailService` are
     * no longer injected: the only thing this controller used them for was
     * issuing and verifying the withdrawal confirmation code, which is gone.
     */
    private readonly transfers: TransfersService,
    private readonly transferExecutor: TransferExecutor,
  ) {}

  /**
   * Declare a deposit the client is about to send — CORE-06.
   *
   * NOTHING IS CREDITED HERE. The row is `pending` and the wallet is untouched
   * until an operator confirms the transfer arrived. That is the honest shape
   * of a deposit without a payment gateway, and it is why this endpoint could
   * be built while the automated one still cannot: `POST /webhooks/payments/
   * :provider` needs Whish/USDT credentials (§12.5, D-05), and this needs none.
   *
   * Idempotent for the same reason a withdrawal is. A double-clicked button
   * would otherwise put two identical declarations into the reconciliation
   * queue with two different references, and the operator would have to work
   * out by hand which one the single incoming payment belongs to.
   *
   * Behind `EmailVerifiedGuard` with the rest of this controller. A client who
   * has not confirmed their address should not be told where to send money.
   */
  /**
   * The deposit methods this client can actually use.
   *
   * NOT behind `KycVerifiedGuard`, like the other two reads: a client deciding
   * whether to verify their identity should be able to see what payment options
   * exist first. Nothing here is theirs — it is the platform's configuration.
   *
   * Only ENABLED and CONFIGURED methods are returned. A method whose pay-to
   * details nobody has filled in cannot receive money, so offering it is
   * offering a dead end — see `PaymentMethodsService.listAvailable`.
   */
  @Get('methods')
  @ApiCookieAuth()
  @ApiOperation({
    summary: 'Deposit methods available to this client',
    description:
      'Enabled methods with configured pay-to details, in the operator’s chosen order. A method ' +
      'the operator has not finished setting up is absent rather than shown as unusable.',
  })
  @ApiOkResponse({ type: PaymentMethodDto, isArray: true })
  listMethods() {
    return this.paymentMethods.listAvailable();
  }

  /**
   * "I have come back from the payment page — did it work?"
   *
   * The client's browser lands on the portal after paying, and this is what that
   * screen calls. It is the SECOND settlement path, and having two is
   * deliberate: a provider callback can be delayed, lost, or blocked by a
   * firewall, and a client staring at a pending deposit they have just paid for
   * is the worst outcome this flow has.
   *
   * Whichever arrives first settles it; the other is a no-op, because
   * settlement is conditional on the row still being pending and the ledger
   * write is guarded by its own uniqueness constraint.
   *
   * AUTHENTICATED, unlike the callback. `settleGatewayDeposit` matches on the
   * reference alone, so without this guard the route would be an oracle for
   * anybody else's payment status.
   */
  /*
   * READ-ONLY, and the caller's own deposit only.
   *
   * This GET used to settle: it asked the provider and credited the wallet.
   * A state change behind a GET is what this codebase refuses elsewhere (the
   * verify-email route is a POST for the same reason) — prefetchers, link
   * scanners and the back button all issue GETs — and it matched on the
   * reference alone, so any verified client could drive the settlement of, and
   * read the state of, another client's payment. Settling is the POST below.
   */
  @Get('deposits/:reference/status')
  @UseGuards(KycVerifiedGuard)
  @ApiCookieAuth()
  @ApiOperation({ summary: "The current state of one of the caller's own gateway deposits" })
  depositStatus(
    @Param('reference') reference: string,
    @Query('method') method: string,
    @Req() req: Request & { user: User },
  ) {
    return this.transactions.gatewayDepositState(method, reference, req.user.id);
  }

  @Post('deposits/:reference/settle')
  @UseGuards(KycVerifiedGuard)
  @HttpCode(HttpStatus.OK)
  @ApiCookieAuth()
  @ApiOperation({
    summary: 'Re-check a gateway deposit with the provider, settling it if it has completed',
    description:
      'Asks the payment provider directly rather than trusting anything the browser carried back. ' +
      'Safe to call repeatedly: settlement is idempotent, so this and the provider callback ' +
      "converge on the same outcome whichever arrives first. Only the deposit's owner may ask.",
  })
  settleDeposit(
    @Param('reference') reference: string,
    @Query('method') method: string,
    @Req() req: Request & { user: User },
  ) {
    return this.transactions.settleGatewayDeposit(method, reference, { ownerId: req.user.id });
  }

  @Post('deposits')
  @UseGuards(KycVerifiedGuard)
  @Idempotent()
  @ApiHeader({
    name: IDEMPOTENCY_HEADER,
    required: true,
    description:
      'A unique value per intended deposit, reused only when retrying that same one. Without ' +
      'it a double-clicked button files two declarations for one transfer, and the operator ' +
      'reconciling the bank statement has to guess which is real (R-5.2).',
  })
  @ApiCookieAuth()
  @ApiOperation({
    summary: 'Declare an incoming deposit and get the reference to quote on the transfer',
    description:
      'Creates a PENDING deposit. No balance changes until the operator confirms the money ' +
      'arrived. The returned reference is what reconciles the payment to this request.',
  })
  @ApiCreatedResponse({ type: DepositRequestDto })
  async requestDeposit(@Body() dto: RequestDepositDto, @Req() req: Request & { user: User }) {
    return await this.transactions.requestDeposit({
      userId: req.user.id,
      amount: dto.amount,
      currency: dto.currency,
      method: dto.method,
      destinationTradingAccountId: dto.destinationTradingAccountId,
    });
  }

  /**
   * The payout rails on offer.
   *
   * Authenticated but NOT KYC-gated, unlike the withdrawal itself: this is the
   * operator's own list of methods, identical for every client, and refusing it
   * to an unverified client would leave the withdrawal screen unable to explain
   * what it is asking for. The money rule stays on the action.
   */
  @Get('withdrawal-methods')
  @ApiCookieAuth()
  @ApiOperation({
    summary: 'The withdrawal methods currently on offer',
    description:
      'Enabled rails only, in display order. The `key` is what POST /payments/withdrawals ' +
      'takes as `methodKey`.',
  })
  @ApiOkResponse({ type: [WithdrawalMethodDto] })
  async listWithdrawalMethods() {
    return await this.transactions.listWithdrawalMethods();
  }

  @Post('withdrawals')
  @UseGuards(KycVerifiedGuard)
  @Idempotent()
  @ApiHeader({
    name: IDEMPOTENCY_HEADER,
    required: true,
    description:
      'A unique value per intended withdrawal, reused only when retrying that same one. ' +
      'Without it a double-clicked button creates two withdrawals and places two holds ' +
      '(PLATFORM-CONVENTIONS R-5.2).',
  })
  @ApiCookieAuth()
  @ApiOperation({
    summary: 'Request a withdrawal — requires KYC level 1; reserves the amount on hold',
  })
  @ApiCreatedResponse({ type: TransactionDto })
  async requestWithdrawal(@Body() dto: RequestWithdrawalDto, @Req() req: Request & { user: User }) {
    /*
     * ── THE EMAIL CONFIRMATION CODE IS GONE ────────────────────────────────
     *
     * FR-CORE-08 / FR-IND-05 put an OTP in front of every withdrawal: a code
     * emailed to the account address and bound by HMAC to the exact amount,
     * currency, destination and method, so a code obtained for a small payout
     * could not authorise a large one. It was removed at the operator's
     * request, along with the two-step form that collected it.
     *
     * WHY IT COULD NOT SIMPLY BE LEFT SWITCHED OFF. The control was gated on
     * `security_settings.withdrawal_otp`, which DEFAULTS TO TRUE when no row
     * exists — deliberately, so a fresh deployment fails safe. The seed writes
     * `false`, but any database where that seed had not run refused every
     * withdrawal from the one-step form with "A confirmation code is
     * required", and there is no admin screen for the switch (the Security tab
     * was removed), so it could only be corrected with SQL.
     *
     * What is still enforced here: KYC level 1 (`KycVerifiedGuard`), the
     * idempotency key, CSRF, and every money rule in
     * `transactions.service.ts` — the balance, the §12.4 per-request and
     * rolling-24h caps, and the rail check.
     */
    return await this.transactions.requestWithdrawal({
      userId: req.user.id,
      amount: dto.amount,
      currency: dto.currency,
      destination: dto.destination,
      methodKey: dto.methodKey,
    });
  }

  /*
   * `POST /payments/withdrawals/otp` and its `intentOf` helper are GONE with
   * the confirmation code — see the note in `requestWithdrawal` above. The
   * portal no longer has a step to call them from, and an endpoint that issues
   * a code nothing will ever verify is a mail send with no purpose.
   */

  /**
   * The signed-in client's own transactions, filtered and ordered by the
   * DATABASE.
   *
   * ## ⚠️ The shape changed, and the old one was under-reporting
   *
   * This returned a bare array capped at 100 rows and took no parameters, so the
   * portal filtered, sorted and counted in the browser while describing the
   * result as the client's whole history. It was the newest hundred — and
   * "showing 4 of 100" beside a history of 150 is R-2.5's failure on the one
   * screen a client would use to find an error in their own ledger.
   *
   * It answers `{ items, total, page, limit }` now. `total` counts every row
   * matching the filters, so the count on screen describes the history rather
   * than the page.
   *
   * The client's id comes from the SESSION and is never a parameter — a `userId`
   * in the query string here would be an oracle for anybody else's money.
   */
  @Get('transactions')
  @ApiCookieAuth()
  @ApiOperation({
    summary: "The signed-in client's own transactions, filtered, ordered and paged",
    description:
      'Every filter is applied by the database against the whole table, so `total` is the real ' +
      'count of matching rows and a sort covers the entire history rather than one page.',
  })
  @ApiOkResponse({ type: TransactionPageDto })
  myTransactions(@Req() req: Request & { user: User }, @Query() query: ListTransactionsQueryDto) {
    return this.transactions.listForUser(req.user.id, query);
  }

  /**
   * Move money between the client's wallet and one of their live MT5 accounts.
   *
   * Idempotent for the same reason the deposit and withdrawal paths are: a
   * double-clicked button would otherwise place two holds and file two
   * transfers for one intended movement (R-5.2).
   *
   * The response is `pending` in both directions, and that is not a
   * placeholder. MT5 owns the account side and there is no bridge yet, so the
   * CRM records what it knows and settles when it is told —
   * `transfers.service.ts` explains why the two directions treat the wallet
   * asymmetrically.
   */
  @Post('transfers')
  @UseGuards(KycVerifiedGuard)
  @Idempotent()
  @ApiHeader({
    name: IDEMPOTENCY_HEADER,
    required: true,
    description: 'A unique value per intended transfer, reused only when retrying that same one.',
  })
  @ApiCookieAuth()
  @ApiOperation({
    summary: 'Transfer between the wallet and a live trading account — requires KYC level 1',
    description:
      'wallet_to_account holds the amount immediately and debits it on settlement. ' +
      'account_to_wallet credits nothing until the bridge confirms MT5 was debited — the CRM ' +
      'never shows money it has not received. Demo accounts are refused.',
  })
  @ApiCreatedResponse({ type: TransferDto })
  async requestTransfer(@Body() dto: RequestTransferDto, @Req() req: Request & { user: User }) {
    const transfer = await this.transfers.request({
      userId: req.user.id,
      tradingAccountId: dto.tradingAccountId,
      direction: dto.direction,
      amount: dto.amount,
      currency: dto.currency,
    });

    /*
     * Executed inline rather than by a worker, and the trade-off is deliberate.
     *
     * A client moving money to their trading account wants to trade with it
     * NOW; a queue would return "pending" and leave them refreshing. The bridge
     * call is a second or two against a server on a private network, which is
     * inside what a request can carry.
     *
     * What makes this safe is that `execute` never leaves money in an unknown
     * place. A refusal fails the transfer and releases the hold; anything
     * INDETERMINATE — a timeout, a reset — leaves it pending on purpose,
     * because the deal may have posted and only the response was lost. Pending
     * is the recoverable state, and the idempotency key is the transfer id, so
     * finishing it later cannot double-apply.
     */
    return await this.transferExecutor.execute(transfer.id);
  }

  @Get('transfers')
  @ApiCookieAuth()
  @ApiOperation({ summary: "The signed-in client's own wallet <-> trading-account transfers" })
  @ApiOkResponse({ type: [TransferDto] })
  myTransfers(@Req() req: Request & { user: User }) {
    return this.transfers.listForUser(req.user.id);
  }
}
