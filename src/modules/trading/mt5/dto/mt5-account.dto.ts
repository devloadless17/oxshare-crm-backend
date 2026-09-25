import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  ClientField,
  NoClientFields,
  NotClientField,
} from '../../../../common/security/client-field.decorator';
import {
  IsIn,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
} from 'class-validator';

/** Open an MT5 trading account for a client. */
export class CreateMt5AccountDto {
  @ApiProperty({ format: 'uuid', description: 'The client this account belongs to.' })
  @IsUUID()
  userId: string;

  /**
   * An MT5 group path, e.g. `real\\Standard`.
   *
   * Not validated against a list here. The set of valid groups lives on the MT5
   * server and is served by `GET /admin/mt5/groups`; a hardcoded enum would
   * drift the first time the broker adds one, and the server rejects an unknown
   * group anyway.
   */
  @ApiProperty({ example: 'real\\Standard' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(128)
  group: string;

  /**
   * Which product the account is opened under — 0142. Required only when the
   * group is sold by more than one product: the product decides the account's
   * commission type, so an ambiguous group is refused rather than guessed.
   * When given, it must be a product that sells the group.
   */
  @ApiPropertyOptional({
    format: 'uuid',
    description:
      'The product to open the account under. Needed when the group is sold by more than one ' +
      'product; must sell the group.',
  })
  @IsOptional()
  @IsUUID()
  productId?: string;

  /**
   * `live` or `demo` — the CRM's own classification.
   *
   * Deliberately NOT inferred from the group name. Broker naming conventions
   * are theirs, `demo\\` is not guaranteed to mean a practice account, and
   * guessing wrong lets a real wallet fund a practice one — which
   * `TransfersService` refuses outright, but only if this field is right.
   */
  @ApiProperty({ enum: ['live', 'demo'] })
  @IsIn(['live', 'demo'])
  environment: 'live' | 'demo';

  @ApiPropertyOptional({
    minimum: 1,
    maximum: 10000,
    description: 'Omit for the group default. MT5 clamps to what the group allows.',
  })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(10_000)
  leverage?: number;
}

/*
 * `Mt5BalanceDto` USED TO BE HERE, with the dealer balance route it fed.
 *
 * Its one good idea outlived it and is worth keeping in sight: the amount was
 * UNSIGNED and a separate `direction` field carried the sign, because a signed
 * amount plus a direction is two sources of truth that can disagree silently —
 * `-100` with `deposit` either credits or debits depending on which the code
 * trusts. `FundTradingAccountDto` follows the same rule for the same reason.
 *
 * The DTO also required a `comment` for MT5's own deal record, which was the
 * only explanation an auditor reading the broker's terminal would ever see.
 * The replacement requires a `reason` instead, and it reaches further: the
 * audit entry, the ledger and the email telling the client their wallet moved.
 */

/**
 * What opening an account returns, ONCE.
 *
 * Declared so the route has a response type — which is not documentation here
 * but enforcement. The RBAC-03 interceptor masks by walking a route's declared
 * shape, so an undeclared response is one it cannot protect; this route was the
 * ninth masking exposure precisely because `credentialsSentTo` IS the client's
 * address and nothing could see it to hide it.
 */
@NoClientFields(
  'the passwords are the MT5 account credentials, shown once and never stored; no client attribute',
)
export class Mt5AccountCredentialsDto {
  @ApiProperty({ description: 'Shown once. Never stored.' }) masterPassword!: string;
  @ApiProperty({ description: 'Shown once. Never stored.' }) investorPassword!: string;
}

export class CreatedMt5AccountDto {
  @NotClientField('an identifier addressing the record, not an attribute of the person behind it')
  @ApiProperty()
  id!: string;

  @NotClientField('the MT5 account NUMBER — identifying, but the catalogue defines no key for it')
  @ApiProperty()
  login!: string;

  @NotClientField('a lifecycle state or classification the desk acts on, not client-owned data')
  @ApiProperty()
  group!: string;

  @NotClientField('a money or configuration value on the RECORD, carrying no client attribute')
  @ApiProperty()
  currency!: string;

  @NotClientField('a money or configuration value on the RECORD, carrying no client attribute')
  @ApiProperty()
  leverage!: number;

  @NotClientField('a lifecycle state or classification the desk acts on, not client-owned data')
  @ApiProperty({ enum: ['live', 'demo'] })
  environment!: 'live' | 'demo';

  /*
   * THE NINTH EXPOSURE. This IS the client's email address, under a name no
   * heuristic over field names would ever have matched — which is the whole
   * argument for stating whose data a field holds rather than inferring it.
   */
  @ClientField('client.email')
  @ApiPropertyOptional({ type: String })
  credentialsSentTo?: string;

  @NotClientField('the mask reporting on ITSELF, so the screen can say hidden rather than empty')
  @ApiPropertyOptional({ type: [String] })
  maskedFields?: string[];
}
