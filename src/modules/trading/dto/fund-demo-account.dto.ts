import { ApiProperty } from '@nestjs/swagger';
import { IsString, Matches } from 'class-validator';

/**
 * Top a demo account up with more practice money.
 *
 * A decimal STRING, like every other amount crossing this boundary (§6.1): the
 * CRM stores money as strings and `Number('10000.5')` is where precision starts
 * to go. The same pattern the opening form's `startingBalance` uses, because
 * this is the same money arriving by a different door.
 *
 * There is no `direction` and no account environment on the body — a client
 * funds their own DEMO account and nothing else, and both facts are established
 * by the service from the session and the row rather than taken from the caller.
 */
export class FundDemoAccountDto {
  @ApiProperty({
    example: '10000.00',
    description:
      'How much practice money to add. Positive decimal string, capped by the operator ' +
      'ceiling reported as `maxDemoDeposit` on /trading/accounts/self-service.',
  })
  @IsString()
  @Matches(/^\d+(\.\d{1,2})?$/, {
    message: 'amount must be a positive decimal with up to 2 places',
  })
  amount: string;
}
