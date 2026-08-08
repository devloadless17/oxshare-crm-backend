import { Controller, Get, Logger, Param, Query } from '@nestjs/common';
import { ApiExcludeEndpoint, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { TransactionsService } from './transactions.service';

/**
 * Where a payment gateway tells us something happened.
 *
 * ## ⚠️ THIS CONTROLLER IS DELIBERATELY UNAUTHENTICATED
 *
 * It is the only route in the payments module without `JwtAuthGuard`, and it has
 * to be: Whish calls it server-to-server with no cookie, no bearer token, no
 * body and no signature. That is the provider's design, not a gap in ours.
 *
 * Which means ANYBODY WHO LEARNS A REFERENCE CAN CALL THIS. The endpoint is
 * therefore treated as a NUDGE — "go and look at this payment" — and never as
 * evidence. `settleGatewayDeposit` asks the provider over an authenticated
 * channel and credits money only on THAT answer.
 *
 * A callback-trusting implementation credits a wallet for whoever can guess a
 * reference. This one cannot be made to pay out by calling it, however many
 * times and with whatever parameters — the worst a forged call achieves is
 * making the server ask Whish a question it already knew the answer to.
 *
 * ## Why it is a separate controller
 *
 * `PaymentsController` is guarded at the class level. Adding an exception inside
 * it would mean one unauthenticated route hiding among twenty authenticated
 * ones, where the next person adding a guard to the class would silently break
 * the provider's callback — or worse, the next person adding a route here would
 * inherit no guard without noticing. A separate file makes the unauthenticated
 * surface of this system greppable.
 *
 * ## Always 200
 *
 * Whish retries or alarms on a non-200, and there is nothing it can usefully do
 * about our internal failures. Every outcome — settled, still pending, unknown
 * reference, provider unreachable — answers 200 with a body saying what
 * happened. The client's money is not at stake in this response: settlement is
 * idempotent and the client's own browser redirect settles it too, so a
 * swallowed callback self-heals on the next look.
 */
@ApiTags('payments')
@Controller('payments/gateway')
export class PaymentCallbacksController {
  private readonly logger = new Logger(PaymentCallbacksController.name);

  constructor(private readonly transactions: TransactionsService) {}

  /**
   * The provider's server-to-server callback.
   *
   * `outcome` is recorded and otherwise IGNORED for the settlement decision.
   * Whish sends a failure callback per failed ATTEMPT while the link stays
   * payable — "a failure callback is not the end of the payment" — so acting on
   * it would mark a deposit failed underneath a client who is about to succeed
   * on their second try. The provider's status is the only thing consulted.
   *
   * Rate limited because it is unauthenticated and public: without a cap it is a
   * free way to make this server hammer Whish's status API.
   */
  @Get(':method/callback')
  @Throttle({ default: { ttl: 60_000, limit: 60 } })
  @ApiExcludeEndpoint()
  @ApiOperation({ summary: 'Payment gateway callback (unauthenticated, provider-to-server)' })
  async callback(
    @Param('method') method: string,
    @Query('reference') reference?: string,
    @Query('outcome') outcome?: string,
  ): Promise<{ received: true; state?: string }> {
    if (!reference) {
      this.logger.warn(`${method} callback arrived with no reference — ignoring.`);
      return { received: true };
    }

    try {
      const result = await this.transactions.settleGatewayDeposit(method, reference);
      this.logger.log(
        `${method} callback for ${reference} (reported ${outcome ?? 'none'}) → ${result.state}`,
      );
      return { received: true, state: result.state };
    } catch (error) {
      /*
       * Swallowed, and 200 anyway. See the class note: a non-200 tells Whish to
       * retry something it cannot fix, and settlement is idempotent — the
       * client's redirect and the next callback both re-attempt it.
       *
       * Logged at WARN rather than ERROR: an unknown reference here is
       * ordinary noise from the public internet, not an incident.
       */
      this.logger.warn(
        `${method} callback for ${reference} could not be settled: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      return { received: true };
    }
  }
}
