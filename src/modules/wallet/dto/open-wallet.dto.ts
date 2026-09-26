import { ApiProperty } from '@nestjs/swagger';
import { IsString, Matches } from 'class-validator';

/**
 * Open a wallet in one currency, on the signed-in user's own request.
 *
 * Only the code: the currency must be one the platform offers, which the
 * service checks against `currencies` rather than a list here — currencies are
 * operator data and change without a deploy.
 *
 * `OpenOwnWalletDto`, NOT `OpenWalletDto`: that name belongs to the admin's
 * `POST /admin/wallets` body (`userId` + currency). Swagger names a schema after
 * its class, so two classes with one name became ONE schema — the contract said
 * a client opening their own wallet must send a `userId`, and which of the two
 * won depended on module load order. `test/dto-class-names.spec.ts` refuses a
 * repeat.
 */
export class OpenOwnWalletDto {
  @ApiProperty({ example: 'EUR', description: 'An enabled currency code, e.g. EUR or USDT.' })
  @IsString()
  @Matches(/^[A-Za-z0-9]{2,10}$/, { message: 'currency must be a currency code, e.g. EUR.' })
  currency!: string;
}
