import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsBoolean,
  IsIn,
  IsNotEmpty,
  IsObject,
  IsOptional,
  IsString,
  MaxLength,
} from 'class-validator';
import { NoClientFields } from '../../../common/security/client-field.decorator';
import { METHOD_AVAILABILITIES, type MethodAvailability } from '../providers/provider-status';

const PROVIDER_STATUSES = [
  'connected',
  'unverified',
  'failing',
  'off',
  'not_configured',
  'sandbox_refused',
] as const;

/** One setting a provider declares, and what is stored for it. */
@NoClientFields('operator configuration - a payment provider setting, no client attribute')
export class ProviderSettingDto {
  @ApiProperty({ example: 'baseUrl' })
  name: string;

  @ApiProperty({ example: 'API base URL' })
  label: string;

  @ApiProperty({ enum: ['url', 'text', 'secret'] })
  kind: 'url' | 'text' | 'secret';

  @ApiProperty({ description: 'The provider cannot be switched on without it.' })
  required: boolean;

  @ApiProperty({ type: String, nullable: true })
  hint: string | null;

  @ApiProperty({
    description:
      'Minted by the platform (a webhook key): rotated with POST …/secrets/:name/rotate, ' +
      'never typed.',
  })
  generated: boolean;

  @ApiProperty({
    type: String,
    nullable: true,
    description: 'The stored value of a URL or text setting. Always null for a secret.',
  })
  value: string | null;

  @ApiProperty({ description: 'Whether a value is stored. A secret is never returned.' })
  isSet: boolean;

  @ApiProperty({
    type: String,
    nullable: true,
    example: '3fa1b2c4',
    description: 'sha256[:8] of a generated secret: which one, without carrying it.',
  })
  fingerprint: string | null;
}

/** One way the provider moves money, as its adapter declares it. */
@NoClientFields('operator configuration - a payment provider channel, no client attribute')
export class ProviderChannelDto {
  @ApiProperty({ example: 'whish' })
  code: string;

  @ApiProperty({ enum: ['deposit', 'payout'] })
  direction: 'deposit' | 'payout';

  @ApiProperty({ example: 'Whish' })
  label: string;

  @ApiProperty({ enum: ['redirect', 'offline', 'adjustment', 'automated', 'desk', 'cash'] })
  flow: string;

  @ApiProperty({ description: 'May a method bind it? False for the desk’s own adjustments.' })
  bindable: boolean;

  @ApiProperty({
    type: [String],
    nullable: true,
    description: 'The currencies it carries; null when the provider judges that itself.',
  })
  currencies: string[] | null;

  @ApiProperty({
    type: String,
    nullable: true,
    enum: ['none', 'phone', 'crypto_address', 'iban', 'text'],
    description: 'Payouts: what the client must give. Null on a deposit channel.',
  })
  destinationKind: string | null;

  @ApiProperty({ type: String, nullable: true, example: 'TRC20' })
  destinationNetwork: string | null;

  @ApiProperty({ type: String, nullable: true, example: 'Whish phone number' })
  destinationLabel: string | null;

  @ApiProperty({ description: 'Deposits paid outside the platform may ask for a receipt.' })
  acceptsReceipt: boolean;

  @ApiProperty({
    type: String,
    nullable: true,
    example: 'USDT on Tron (TRC20)',
    description:
      'What moves at the provider when it is not the wallet currency — credited and paid at ' +
      'par (0173). Null when the provider moves the wallet currency itself.',
  })
  assetLabel: string | null;

  @ApiProperty({
    type: String,
    nullable: true,
    enum: ['exact', 'received'],
    description:
      'Hosted deposits: `exact` credits the link’s amount (any other figure is a person’s ' +
      'decision); `received` credits what arrived, rounded down. Null on other channels.',
  })
  creditPolicy: 'exact' | 'received' | null;

  @ApiProperty({
    description:
      'The admin’s switch for this channel in this direction (0173). Off: its methods are ' +
      'hidden and new movements refused; movements already under way still finish.',
  })
  enabled: boolean;

  @ApiProperty({ type: String, nullable: true, description: 'Why it was switched off.' })
  offReason: string | null;

  @ApiProperty({ type: String, nullable: true, description: 'When it was switched off (ISO).' })
  offSince: string | null;
}

/** Switch one channel on or off in one direction (0173). */
export class SetProviderChannelDto {
  @ApiProperty()
  @IsBoolean()
  enabled: boolean;

  @ApiPropertyOptional({
    maxLength: 500,
    description: 'Required to switch a channel off — shown on the desk and the methods.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  reason?: string;
}

/** A method bound to one of the provider's channels. */
@NoClientFields('operator configuration - a payment method, no client attribute')
export class ProviderMethodDto {
  @ApiProperty({ description: 'The method’s permanent id; the console never shows it.' })
  key: string;

  @ApiProperty({ example: 'Whish (Rival)', description: 'What the desk calls it.' })
  internalLabel: string;

  @ApiProperty({ example: 'Whish Money', description: 'What clients see.' })
  name: string;

  @ApiProperty({ enum: ['deposit', 'payout'] })
  direction: 'deposit' | 'payout';

  @ApiProperty({ example: 'whish' })
  channelCode: string;

  @ApiProperty()
  enabled: boolean;

  @ApiProperty({
    enum: METHOD_AVAILABILITIES,
    description:
      'Deposit methods: whether clients are offered it, and if not, why. A payout method is ' +
      'offered whenever it is enabled — see `paidBy`.',
  })
  availability: MethodAvailability;

  @ApiProperty({
    type: String,
    nullable: true,
    enum: ['provider', 'desk'],
    description: 'Payout methods: who pays a request now. Null on a deposit method.',
  })
  paidBy: 'provider' | 'desk' | null;
}

@NoClientFields('operator figures - counts of movements, no client attribute')
export class ProviderActivityDto {
  @ApiProperty({ description: 'Deposits and withdrawals filed on this provider in the last 24h.' })
  total: number;

  @ApiProperty()
  succeeded: number;

  @ApiProperty({ description: 'Failed or rejected.' })
  failed: number;

  @ApiProperty({ description: 'Still pending, or approved and awaiting the payout.' })
  pending: number;
}

@NoClientFields('operator figures - a connection test result, no client attribute')
export class ProviderCheckDto {
  @ApiProperty()
  at: string;

  @ApiProperty()
  ok: boolean;

  @ApiProperty({ type: String, nullable: true })
  message: string | null;
}

/** A payment provider: its state, its settings, its channels and the methods on them. */
@NoClientFields('operator configuration - a payment provider, no client attribute')
export class PaymentProviderDto {
  @ApiProperty({ example: 'rival' })
  code: string;

  @ApiProperty({ example: 'Rival' })
  name: string;

  @ApiProperty({ description: 'Built into the platform (the desk): always on, no settings.' })
  builtIn: boolean;

  @ApiProperty()
  enabled: boolean;

  @ApiProperty({ enum: ['live', 'sandbox'] })
  environment: 'live' | 'sandbox';

  @ApiProperty({ enum: PROVIDER_STATUSES })
  status: (typeof PROVIDER_STATUSES)[number];

  @ApiProperty({ type: String, nullable: true, description: 'One sentence explaining the status.' })
  statusMessage: string | null;

  @ApiProperty({ description: 'Can its methods take money right now?' })
  usable: boolean;

  @ApiProperty({
    type: String,
    nullable: true,
    enum: ['console', 'environment'],
    description:
      '`environment`: nothing is saved here and the deployment’s variables configure it (a ' +
      'development floor). Null for a built-in provider or one not set up.',
  })
  configuredFrom: 'console' | 'environment' | null;

  @ApiProperty({ type: String, nullable: true, description: 'The last verified inbound event.' })
  lastEventAt: string | null;

  @ApiPropertyOptional({ type: ProviderCheckDto, nullable: true })
  lastCheck: ProviderCheckDto | null;

  @ApiProperty({
    type: String,
    nullable: true,
    description: 'Where the provider must deliver its events. Null without API_PUBLIC_URL.',
  })
  webhookEndpoint: string | null;

  @ApiProperty({ type: [ProviderSettingDto] })
  settings: ProviderSettingDto[];

  @ApiProperty({ type: [ProviderChannelDto] })
  channels: ProviderChannelDto[];

  @ApiProperty({ type: [ProviderMethodDto] })
  methods: ProviderMethodDto[];

  @ApiProperty({ type: ProviderActivityDto })
  last24h: ProviderActivityDto;

  @ApiProperty({ type: String, nullable: true })
  updatedAt: string | null;

  @ApiProperty({
    description:
      'Are this provider’s own records audited for movements no transaction here explains (0174)?',
  })
  auditsRecords: boolean;

  @ApiProperty({
    description: 'Movements at the provider no transaction here explains, not yet acknowledged.',
    example: 0,
  })
  unexplainedRecords: number;
}

/**
 * A movement the provider recorded that no transaction here explains (0174):
 * a payout made by hand in its dashboard, a deposit on a link this platform
 * never made. Named by the provider, never tied to a client here.
 */
@NoClientFields('operator records - a provider’s own movement, tied to no client here')
export class UnmatchedProviderRecordDto {
  @ApiProperty()
  id: string;

  @ApiProperty({ enum: ['payment', 'payout'] })
  subject: 'payment' | 'payout';

  @ApiProperty({ description: 'The provider’s id for it.', example: 'WD-1788182251668-6a47bbcf' })
  providerId: string;

  @ApiProperty({ example: 'completed' })
  rawStatus: string;

  @ApiProperty({ type: 'string', nullable: true, example: '500.00000000' })
  amount: string | null;

  @ApiProperty({ type: String, nullable: true, example: 'USDT-TRC20' })
  asset: string | null;

  @ApiProperty({
    type: String,
    nullable: true,
    description: 'The address paid, or the deposit address, as the provider reported it.',
  })
  counterparty: string | null;

  @ApiProperty({ type: String, nullable: true, description: 'Our reference, when echoed.' })
  reference: string | null;

  @ApiProperty({ description: 'When the provider recorded it (ISO).' })
  occurredAt: string;

  @ApiProperty({ description: 'When the audit filed it (ISO).' })
  foundAt: string;

  @ApiProperty({ type: String, nullable: true, description: 'A transaction that holds it since.' })
  matchedTransactionId: string | null;

  @ApiProperty({ type: String, nullable: true })
  acknowledgedAt: string | null;

  @ApiProperty({ type: String, nullable: true, description: 'Why it is a company movement.' })
  acknowledgement: string | null;
}

export class AcknowledgeProviderRecordDto {
  @ApiProperty({
    description: 'What this movement was — required, shown on the record and in the audit log.',
    example: 'Treasury sweep to the cold wallet, approved by finance.',
  })
  @IsString()
  @IsNotEmpty()
  @MaxLength(500)
  note: string;
}

/**
 * A change to a provider. Every part is optional and merged:
 *   `settings` — URL and text settings by name; `null` or `''` removes one.
 *   `secrets`  — typed secrets (an API key) by name, write-only; `null` or `''`
 *                removes one. A GENERATED secret is never accepted here — it is
 *                rotated, so a hand-chosen webhook key can never authenticate a
 *                money-event stream.
 * An absent key is left as it is, so switching a provider off cannot wipe a
 * credential by omission.
 */
export class UpdatePaymentProviderDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  enabled?: boolean;

  @ApiPropertyOptional({ enum: ['live', 'sandbox'] })
  @IsOptional()
  @IsIn(['live', 'sandbox'])
  environment?: 'live' | 'sandbox';

  @ApiPropertyOptional({
    type: 'object',
    additionalProperties: { type: 'string', nullable: true },
    example: { baseUrl: 'https://portal.rivalpayments.com/v1' },
  })
  @IsOptional()
  @IsObject()
  settings?: Record<string, string | null>;

  @ApiPropertyOptional({
    type: 'object',
    additionalProperties: { type: 'string', nullable: true },
    example: { apiKey: 'tsk_…' },
  })
  @IsOptional()
  @IsObject()
  secrets?: Record<string, string | null>;
}

@NoClientFields('operator configuration - a freshly minted secret, no client attribute')
export class RotatedProviderSecretDto {
  @ApiProperty({ example: 'webhookKey' })
  name: string;

  @ApiProperty({
    description:
      'The new secret, in plaintext, THIS ONCE — paste it into the provider’s dashboard. It is ' +
      'never retrievable again.',
  })
  secret: string;

  @ApiProperty({ example: '3fa1b2c4' })
  fingerprint: string;

  @ApiProperty({ type: String, nullable: true })
  webhookEndpoint: string | null;
}

@NoClientFields('operator configuration - a connection test result, no client attribute')
export class ProviderTestResultDto {
  @ApiProperty()
  ok: boolean;

  @ApiProperty()
  message: string;

  @ApiProperty()
  checkedAt: string;
}

@NoClientFields('provider event log - what a provider reported, no client attribute')
export class ProviderEventDto {
  @ApiProperty()
  id: string;

  @ApiProperty({
    example: 'payment.succeeded',
    description:
      'payment.pending|succeeded|failed|reversed, payout.submitted|completed|rejected|cancelled',
  })
  eventType: string;

  @ApiProperty({ type: String, nullable: true, example: 'transaction.completed' })
  providerType: string | null;

  @ApiProperty({ enum: ['webhook', 'poll', 'desk'] })
  source: string;

  @ApiProperty({ enum: ['applied', 'ignored', 'rejected', 'failed'] })
  outcome: string;

  @ApiProperty({ type: String, nullable: true })
  reason: string | null;

  @ApiProperty({ type: String, nullable: true })
  transactionId: string | null;

  @ApiProperty()
  receivedAt: string;
}
