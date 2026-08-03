import { Body, Controller, Get, Post, Req, UseGuards } from '@nestjs/common';
import { ApiCookieAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { IsIn, IsNotEmpty, IsNumberString, IsString } from 'class-validator';
import { Request } from 'express';
import { JwtAuthGuard } from '../identity/guards/jwt-auth.guard';
import { EmailVerifiedGuard } from '../identity/guards/email-verified.guard';
import { User } from '../../store/users.store';
import { TransactionsService } from './transactions.service';

class RequestWithdrawalDto {
  // Money arrives as a STRING and stays one (§6.1) — @IsNumberString, never
  // @IsNumber, so it is never parsed into a float on the way in.
  @IsNumberString() amount: string;
  @IsIn(['USD', 'USDT']) currency: 'USD' | 'USDT';
  @IsString() @IsNotEmpty() destination: string;
  @IsIn(['whish', 'usdt']) provider: 'whish' | 'usdt';
}

@ApiTags('payments')
@UseGuards(JwtAuthGuard, EmailVerifiedGuard)
@Controller('payments')
export class PaymentsController {
  constructor(private readonly transactions: TransactionsService) {}

  @Post('withdrawals')
  @ApiCookieAuth()
  @ApiOperation({
    summary: 'Request a withdrawal — requires KYC level 1; reserves the amount on hold',
  })
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
  myTransactions(@Req() req: Request & { user: User }) {
    return this.transactions.listForUser(req.user.id);
  }
}
