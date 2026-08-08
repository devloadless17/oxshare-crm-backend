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
import { Throttle } from '@nestjs/throttler';
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
import {
  RequestWithdrawalDto,
  RequestWithdrawalOtpDto,
  TransactionDto,
  WithdrawalOtpResponseDto,
} from './dto/withdrawal.dto';
import { WithdrawalOtpService, type WithdrawalIntent } from './withdrawal-otp.service';
import { SecuritySettingsService } from '../admin/security-settings.service';
import { SECURITY_SWITCHES } from '../../store/security-settings.store';
import { EmailService } from '../email/email.service';
import { ValidationError } from '../../common/errors/domain-errors';
import { DepositRequestDto, RequestDepositDto } from './dto/deposit.dto';
import { TransfersService } from './transfers.service';
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
    private readonly otp: WithdrawalOtpService,
    private readonly securitySettings: SecuritySettingsService,
    private readonly email: EmailService,
    private readonly transfers: TransfersService,
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
  @Get('deposits/:reference/status')
  @UseGuards(KycVerifiedGuard)
  @ApiCookieAuth()
  @ApiOperation({
    summary: 'Re-check a gateway deposit with the provider, settling it if it has completed',
    description:
      'Asks the payment provider directly rather than trusting anything the browser carried back. ' +
      'Safe to call repeatedly: settlement is idempotent, so this and the provider callback ' +
      'converge on the same outcome whichever arrives first.',
  })
  settleDeposit(@Param('reference') reference: string, @Query('method') method: string) {
    return this.transactions.settleGatewayDeposit(method, reference);
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
     * FR-CORE-08 / FR-IND-05 — the email OTP gate.
     *
     * AT THE EDGE, not in the service, and that is a considered exception to
     * R-4.3 rather than an oversight. R-4.3 puts authorization in the service
     * because a queued job has no controller and no guard, and a permission
     * check must still run for it. An OTP is not that kind of check: it proves
     * that a HUMAN WITH MAILBOX ACCESS initiated this specific request, which is
     * meaningless for a job and impossible for one to satisfy. It belongs with
     * CSRF and the idempotency key — transport-level proof of intent. The money
     * rules that a job WOULD have to satisfy (KYC level, balance, the §12.4
     * limits) stay in `transactions.service.ts` where R-4.3 wants them.
     */
    if (await this.securitySettings.isEnabled(SECURITY_SWITCHES.withdrawalOtp)) {
      if (!dto.otp) {
        throw new ValidationError(
          'A confirmation code is required. Request one, then submit this withdrawal with the ' +
            'code from your email.',
          { otpRequired: true },
        );
      }
      // Bound to THIS withdrawal — see withdrawal-otp.service.ts. A code issued
      // for a different amount, destination or provider does not verify here.
      await this.otp.verify(this.intentOf(req.user.id, dto), dto.otp);
    }

    return await this.transactions.requestWithdrawal({
      userId: req.user.id,
      amount: dto.amount,
      currency: dto.currency,
      destination: dto.destination,
      provider: dto.provider,
    });
  }

  @Post('withdrawals/otp')
  @UseGuards(KycVerifiedGuard)
  @HttpCode(HttpStatus.OK)
  // 3 sends per 15 minutes per USER is enforced in the service (R-3.7); this is
  // the per-IP bound in front of it, because the service limit needs a session
  // and this route sends mail to an address we hold.
  @Throttle({ default: { ttl: 900_000, limit: 10 } })
  @ApiCookieAuth()
  @ApiOperation({
    summary: 'Send a confirmation code for one specific withdrawal (FR-CORE-08)',
    description:
      'The code is bound to the exact amount, currency, destination and provider supplied here. ' +
      'Changing any of them before submitting makes the code invalid, which is what stops a code ' +
      'obtained for a small withdrawal from authorising a large one.',
  })
  @ApiOkResponse({ type: WithdrawalOtpResponseDto })
  async sendWithdrawalOtp(
    @Body() dto: RequestWithdrawalOtpDto,
    @Req() req: Request & { user: User },
  ) {
    if (!(await this.securitySettings.isEnabled(SECURITY_SWITCHES.withdrawalOtp))) {
      // Answered rather than 404'd, so the portal's flow is identical whether or
      // not the control is on — the client simply is not asked for a code.
      return { message: 'Withdrawal confirmation is not required.', required: false };
    }

    const code = await this.otp.issue(this.intentOf(req.user.id, dto));
    // The code goes to the mailbox and NOWHERE else — not this response body,
    // not a log line (R-6.3). `void` because a slow SMTP server must not hold
    // the request open; a failure is logged inside the service.
    void this.email.sendWithdrawalOtpEmail(req.user.email, dto.amount, dto.currency, code);

    return {
      message: 'A confirmation code has been sent to your email address. It expires in 5 minutes.',
      required: true,
    };
  }

  /** One spelling of the intent, so issue and verify cannot disagree. */
  private intentOf(userId: string, dto: RequestWithdrawalOtpDto): WithdrawalIntent {
    return {
      userId,
      amount: dto.amount,
      currency: dto.currency,
      destination: dto.destination,
      provider: dto.provider,
    };
  }

  @Get('transactions')
  @ApiCookieAuth()
  @ApiOperation({ summary: "The signed-in client's own transactions" })
  @ApiOkResponse({ type: [TransactionDto] })
  myTransactions(@Req() req: Request & { user: User }) {
    return this.transactions.listForUser(req.user.id);
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
    return await this.transfers.request({
      userId: req.user.id,
      tradingAccountId: dto.tradingAccountId,
      direction: dto.direction,
      amount: dto.amount,
      currency: dto.currency,
    });
  }

  @Get('transfers')
  @ApiCookieAuth()
  @ApiOperation({ summary: "The signed-in client's own wallet <-> trading-account transfers" })
  @ApiOkResponse({ type: [TransferDto] })
  myTransfers(@Req() req: Request & { user: User }) {
    return this.transfers.listForUser(req.user.id);
  }
}
