import { Body, Controller, Get, Post, Req, UseGuards, UseInterceptors } from '@nestjs/common';
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
import { RequestWithdrawalDto, TransactionDto } from './dto/withdrawal.dto';

@ApiTags('payments')
@UseGuards(JwtAuthGuard, EmailVerifiedGuard)
@UseInterceptors(IdempotencyInterceptor)
@Controller('payments')
export class PaymentsController {
  constructor(private readonly transactions: TransactionsService) {}

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
  requestWithdrawal(@Body() dto: RequestWithdrawalDto, @Req() req: Request & { user: User }) {
    // NOTE (§8.4): the email-OTP gate belongs here and is not built yet — it
    // requires Redis for the 5-minute single-use TTL ("never in Postgres").
    // Tracked in DECISIONS D-38.
    return this.transactions.requestWithdrawal({
      userId: req.user.id,
      amount: dto.amount,
      currency: dto.currency,
      destination: dto.destination,
      provider: dto.provider,
    });
  }

  @Get('transactions')
  @ApiCookieAuth()
  @ApiOperation({ summary: "The signed-in client's own transactions" })
  @ApiOkResponse({ type: [TransactionDto] })
  myTransactions(@Req() req: Request & { user: User }) {
    return this.transactions.listForUser(req.user.id);
  }
}
