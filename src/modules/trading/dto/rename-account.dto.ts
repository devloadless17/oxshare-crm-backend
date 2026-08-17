import { ApiProperty } from '@nestjs/swagger';
import { IsString, MaxLength, MinLength } from 'class-validator';

/**
 * Renaming an existing trading account.
 *
 * The name is the account HOLDER's as MT5 records it — what the client sees in
 * their terminal and on statements — not a CRM-side nickname. There is no local
 * column for it, so this writes straight through to the trading server.
 *
 * `MinLength(1)` catches an empty string; the SERVICE trims and re-checks,
 * because class-validator sees `'   '` as three perfectly good characters while
 * MT5 accepts it and then shows an account belonging to nobody.
 */
export class RenameOwnAccountDto {
  @ApiProperty({
    maxLength: 128,
    example: 'Swing trading',
    description: "The account holder's name as MT5 will show it.",
  })
  @IsString()
  @MinLength(1)
  @MaxLength(128)
  name: string;
}
