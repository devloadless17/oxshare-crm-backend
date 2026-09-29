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
  Matches,
  Max,
  MaxLength,
  Min,
  ValidateIf,
} from 'class-validator';

/** Open an MT5 trading account for a client. */
export class CreateMt5AccountDto {
  @ApiProperty({ type: 'integer', description: 'The client this account belongs to.' })
  @IsInt()
  @Min(1)
  userId: number;

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

/*
 * ── Linking an EXISTING MT5 account to a client (owner, 29 Sep 2026) ──────────
 *
 * The broker's server already holds accounts the CRM has never recorded — opened
 * in the manager terminal, or on the platform this one replaced. Their deals are
 * ingested and wait as orphans; their snapshots are dropped. Linking records the
 * login under a client, with the product whose terms its trades pay, and from
 * the next run those waiting deals accrue like any other client's.
 */

/** Link a login MT5 already has to a client. */
export class LinkMt5AccountDto {
  @ApiProperty({ type: 'integer', description: 'The client the account is linked to.' })
  @IsInt()
  @Min(1)
  userId: number;

  @ApiProperty({ example: '5000123', description: 'The MT5 login, as digits.' })
  @IsString()
  @Matches(/^\d{1,20}$/, { message: 'login must be the MT5 login number' })
  login: string;

  @ApiPropertyOptional({
    format: 'uuid',
    description:
      "The product whose commission terms the account's trades pay. Must sell the account's " +
      'group; required when several products do, and optional when one does (it is used).',
  })
  @IsOptional()
  @IsUUID()
  productId?: string;
}

/** Set, change or clear the product an account's trades pay under. */
export class SetTradingAccountProductDto {
  @ApiProperty({
    type: String,
    format: 'uuid',
    nullable: true,
    description: "A product that sells the account's MT5 group, or null to record none.",
  })
  @ValidateIf((_o, value) => value !== null)
  @IsUUID()
  productId: string | null;
}

@NoClientFields('an MT5 server record read for an operator, not a CRM client record')
export class Mt5ProductOptionDto {
  @ApiProperty({ format: 'uuid' }) id: string;
  @ApiProperty({ example: 'Standard' }) name: string;
}

@NoClientFields('an MT5 server record read for an operator, not a CRM client record')
export class Mt5AccountOwnerDto {
  @ApiPropertyOptional({
    type: 'integer',
    description: 'Absent when the owner is outside your territory.',
  })
  portalId?: number;
  @ApiPropertyOptional({ description: 'Absent when the owner is outside your territory.' })
  name?: string;
  @ApiProperty({ description: 'True when a client you may not see already owns it.' })
  outsideTerritory: boolean;
}

/**
 * One MT5 login as the link screen shows it: what MT5 says it is and who holds
 * it there, whether the CRM already has it, what it could be linked under, and
 * how many of its deals are waiting for an owner.
 */
export class Mt5AccountLookupDto {
  @NotClientField('an MT5 server value about the account, read for the operator linking it')
  @ApiProperty({ example: '5000123' })
  login: string;
  @NotClientField('an MT5 server value about the account, read for the operator linking it')
  @ApiProperty({ example: 'real\\Standard' })
  group: string;
  @NotClientField('an MT5 server value about the account, read for the operator linking it')
  @ApiProperty({ example: 'USD' })
  currency: string;
  @NotClientField('an MT5 server value about the account, read for the operator linking it')
  @ApiProperty({ type: 'integer' })
  leverage: number;
  @NotClientField('an MT5 server value about the account, read for the operator linking it')
  @ApiProperty({ type: 'string', example: '1250.00000000' })
  balance: string;
  @NotClientField('an MT5 server value about the account, read for the operator linking it')
  @ApiProperty({ type: 'string', example: '1250.00000000' })
  equity: string;
  @NotClientField('an MT5 server value about the account, read for the operator linking it')
  @ApiProperty({ type: 'string', example: '0.00000000' })
  credit: string;

  /*
   * MT5's OWN record of the holder, not a CRM client field — read live for the
   * operator linking the account. The service still withholds each one from a
   * role whose field mask hides client names or emails.
   */
  @NotClientField(
    "MT5's record of the account holder, withheld by the service under the field mask",
  )
  @NotClientField('an MT5 server value about the account, read for the operator linking it')
  @ApiPropertyOptional({
    type: String,
    nullable: true,
    description:
      "The holder's name as MT5 records it; null if the bridge could not say or your role hides names.",
  })
  holderName: string | null;
  @NotClientField(
    "MT5's record of the account holder, withheld by the service under the field mask",
  )
  @NotClientField('an MT5 server value about the account, read for the operator linking it')
  @ApiPropertyOptional({
    type: String,
    nullable: true,
    description: 'Null if the bridge could not say or your role hides emails.',
  })
  holderEmail: string | null;

  @NotClientField('an MT5 server value about the account, read for the operator linking it')
  @ApiProperty({
    enum: ['live', 'demo'],
    nullable: true,
    description: 'What the catalogue sells the group as; null when no product carries it.',
  })
  environment: 'live' | 'demo' | null;

  @NotClientField('an MT5 server value about the account, read for the operator linking it')
  @ApiProperty({ description: "Whether the account's currency is one this platform holds." })
  currencyKnown: boolean;

  @NotClientField('an MT5 server value about the account, read for the operator linking it')
  @ApiProperty({ type: [Mt5ProductOptionDto], description: 'The products that sell this group.' })
  products: Mt5ProductOptionDto[];

  @NotClientField('an MT5 server value about the account, read for the operator linking it')
  @ApiPropertyOptional({
    type: Mt5AccountOwnerDto,
    nullable: true,
    description: 'The CRM client who already owns this login; null when nobody does.',
  })
  owner: Mt5AccountOwnerDto | null;

  @NotClientField('an MT5 server value about the account, read for the operator linking it')
  @ApiProperty({
    type: 'integer',
    description:
      'Deals on this login ingested but not yet paid on — they accrue once it is linked.',
  })
  waitingDeals: number;
}

/** What setting an account's product answers with. */
@NoClientFields('a trading account record addressed by id; the client is named elsewhere')
export class TradingAccountProductDto {
  @ApiProperty({ format: 'uuid' }) id: string;
  @ApiProperty({ format: 'uuid', nullable: true, type: String }) productId: string | null;
}

/** The account as the link recorded it. */
@NoClientFields('a trading account record addressed by id; the client is named elsewhere')
export class LinkedMt5AccountDto {
  @ApiProperty({ format: 'uuid' }) id: string;
  @ApiProperty() login: string;
  @ApiProperty() group: string;
  @ApiProperty({ format: 'uuid', nullable: true, type: String }) productId: string | null;
  @ApiProperty({ enum: ['live', 'demo'] }) environment: 'live' | 'demo';
  @ApiProperty() currency: string;
  @ApiProperty({ type: 'string' }) balance: string;
  @ApiProperty({ type: 'integer', description: 'Deals now waiting to accrue on the next run.' })
  waitingDeals: number;
}
