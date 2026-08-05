import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Post,
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
import { User } from '../../store/users.store';
import { TransactionsService } from './transactions.service';
import {
  RequestWithdrawalDto,
  RequestWithdrawalOtpDto,
  TransactionDto,
} from './dto/withdrawal.dto';
import { MessageResponseDto } from '../../common/dto/message-response.dto';
import { WithdrawalOtpService, type WithdrawalIntent } from './withdrawal-otp.service';
import { SecuritySettingsService } from '../admin/security-settings.service';
import { SECURITY_SWITCHES } from '../../store/security-settings.store';
import { EmailService } from '../email/email.service';
import { ValidationError } from '../../common/errors/domain-errors';

@ApiTags('payments')
@UseGuards(JwtAuthGuard, EmailVerifiedGuard)
@UseInterceptors(IdempotencyInterceptor)
@Controller('payments')
export class PaymentsController {
  constructor(
    private readonly transactions: TransactionsService,
    private readonly otp: WithdrawalOtpService,
    private readonly securitySettings: SecuritySettingsService,
    private readonly email: EmailService,
  ) {}

  @Post('withdrawals')
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
  @ApiOkResponse({ type: MessageResponseDto })
  async sendWithdrawalOtp(
    @Body() dto: RequestWithdrawalOtpDto,
    @Req() req: Request & { user: User },
  ) {
    if (!(await this.securitySettings.isEnabled(SECURITY_SWITCHES.withdrawalOtp))) {
      // Answered rather than 404'd, so the portal's flow is identical whether or
      // not the control is on — the client simply is not asked for a code.
      return { message: 'Withdrawal confirmation is not required.' };
    }

    const code = await this.otp.issue(this.intentOf(req.user.id, dto));
    // The code goes to the mailbox and NOWHERE else — not this response body,
    // not a log line (R-6.3). `void` because a slow SMTP server must not hold
    // the request open; a failure is logged inside the service.
    void this.email.sendWithdrawalOtpEmail(req.user.email, dto.amount, dto.currency, code);

    return {
      message: 'A confirmation code has been sent to your email address. It expires in 5 minutes.',
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
}
