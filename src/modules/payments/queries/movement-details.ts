import type { CsvColumn } from '../../../common/export/csv';
import { money } from '../../wallet/money';
import { effectOf, movementTypeOf, type MovementEffect, type MovementType } from '../movement-type';
import type { TransferOrigin } from '../transfer-provenance';

/**
 * One end of a movement — where its money came FROM or went TO (16 Oct 2026).
 *
 *   wallet           a client wallet: its number (the console's identifier), kind and currency
 *   trading_account  an MT5 account: its login and Live/Demo — never the client's nickname for it
 *   external         OUTSIDE the platform: where a deposit's money came from, where a
 *                    withdrawal's went. A PLACE, never the rail: the method it crossed on is
 *                    the row's own `method` (the owner's call, 16 Oct 2026 — ledgers and bank
 *                    statements keep the counterparty and the payment method apart). The payout
 *                    destination TEXT stays in the masked `destination`.
 *   company          the desk's own money: new money credited in, or money taken out by hand
 */
export interface MovementEnd {
  kind: 'wallet' | 'trading_account' | 'external' | 'company';
  walletId?: string | null;
  walletNumber?: string | null;
  walletKind?: string | null;
  currency?: string | null;
  tradingAccountId?: string | null;
  login?: string | null;
  environment?: string | null;
}

/** The rail a payment crossed the platform on — its own attribute, never an end. */
export interface MovementMethod {
  label: string | null;
  providerCode: string | null;
  /** The channel, e.g. a network (TRC20). */
  channelCode: string | null;
  /** The provider's environment when it is not live (a sandbox payment). */
  environment: string | null;
}

/** A desk member, by name only — `admins.view` keeps the directory narrow, so never an email. */
export interface AdminRef {
  adminId: string;
  name: string | null;
  at?: Date | null;
}

/** The detail columns `MOVEMENT_DETAIL_COLUMNS` adds to each page row. */
export interface MovementDetailRow {
  id: string;
  kind: string;
  direction: string;
  wallet_id: string;
  currency: string;
  trading_account_id: string | null;
  route_provider: string | null;
  route_channel: string | null;
  transfer_origin: TransferOrigin | null;
  reviewed_by: string | null;
  reviewed_at: string | null;
  method_name: string | null;
  method_label?: string | null;
  provider_payout_id: string | null;
  provider_submitted_at: string | null;
  wallet_number: string | null;
  wallet_kind: string | null;
  account_login: string | null;
  account_environment: string | null;
  from_wallet_id: string | null;
  from_wallet_number: string | null;
  from_wallet_kind: string | null;
  source_transaction_id: string | null;
  transfer_requested_by: string | null;
  transfer_desk_reason: string | null;
  transfer_desk_reason_ar: string | null;
  source_provider: string | null;
  source_ref: string | null;
  source_settled_at: string | null;
  source_method_label: string | null;
  approved_by: string | null;
  approved_at: string | null;
  payment_desk_reason: string | null;
  payment_desk_reason_ar: string | null;
  provider_environment: string | null;
  provider_fee: string | null;
  provider_net_amount: string | null;
  provider_request_amount: string | null;
  provider_amount_received: string | null;
  requested_amount: string | null;
  provider_status: string | null;
  provider_checked_at: string | null;
  onward_transfer_id: string | null;
  onward_state: string | null;
  onward_account_id: string | null;
  onward_login: string | null;
  onward_environment: string | null;
  requested_by_name: string | null;
  approved_by_name: string | null;
  decided_by_name: string | null;
}

const at = (value: string | null): Date | null => (value === null ? null : new Date(value));
const amount = (value: string | null): string | null => (value === null ? null : money(value));

/** The transfer table's state words, in the union's vocabulary. */
function unionState(state: string | null): 'pending' | 'success' | 'failure' | null {
  if (state === null) return null;
  if (state === 'settled') return 'success';
  if (state === 'failed') return 'failure';
  return 'pending';
}

/**
 * Everything an admin needs to read a movement without opening anything else: what it is, from
 * where to where, where its money came from, who asked, approved and decided, why, and what the
 * provider charged. Pure: the same row always reads the same, on the screen and in the file.
 */
export function movementDetails(row: MovementDetailRow) {
  const type: MovementType = movementTypeOf({
    kind: row.kind,
    direction: row.direction,
    routeProvider: row.route_provider,
    routeChannel: row.route_channel,
  });
  const effect: MovementEffect = effectOf(type);

  const wallet: MovementEnd = {
    kind: 'wallet',
    walletId: row.wallet_id,
    walletNumber: row.wallet_number,
    walletKind: row.wallet_kind,
    currency: row.currency,
  };
  const account: MovementEnd = {
    kind: 'trading_account',
    tradingAccountId: row.trading_account_id,
    login: row.account_login,
    environment: row.account_environment,
  };
  const external: MovementEnd = { kind: 'external' };
  // Only a payment crosses the platform's edge; a transfer or a commission move has no method.
  const method: MovementMethod | null =
    row.kind === 'payment'
      ? {
          label: row.method_label ?? row.method_name ?? null,
          providerCode: row.route_provider,
          channelCode: row.route_channel,
          environment: row.provider_environment,
        }
      : null;
  const company: MovementEnd = { kind: 'company' };

  let from: MovementEnd;
  let to: MovementEnd;
  switch (type) {
    case 'deposit':
      [from, to] = [external, wallet];
      break;
    case 'desk_credit':
      [from, to] = [company, wallet];
      break;
    case 'withdrawal':
      [from, to] = [wallet, external];
      break;
    case 'desk_debit':
      [from, to] = [wallet, company];
      break;
    case 'transfer_to_account':
      [from, to] = [wallet, account];
      break;
    case 'transfer_to_wallet':
      [from, to] = [account, wallet];
      break;
    case 'commission_to_wallet':
      from = {
        kind: 'wallet',
        walletId: row.from_wallet_id,
        walletNumber: row.from_wallet_number,
        walletKind: row.from_wallet_kind,
        currency: row.currency,
      };
      to = wallet;
      break;
  }

  // A deposit aimed at a trading account: the transfer that moved it on — or the fact it did not.
  const onward =
    row.kind === 'payment' && row.onward_account_id
      ? {
          transferId: row.onward_transfer_id,
          state: unionState(row.onward_state),
          account: {
            kind: 'trading_account' as const,
            tradingAccountId: row.onward_account_id,
            login: row.onward_login,
            environment: row.onward_environment,
          },
        }
      : null;

  const source = row.source_transaction_id
    ? {
        transactionId: row.source_transaction_id,
        methodLabel: row.source_method_label,
        // The desk's credit carries an idempotency key there, never a reference anybody quotes.
        reference: row.source_provider === 'manual_admin' ? null : row.source_ref,
        settledAt: at(row.source_settled_at),
      }
    : null;

  const deskPayment = type === 'desk_credit' || type === 'desk_debit';
  const requestedById = row.transfer_requested_by ?? (deskPayment ? row.reviewed_by : null);

  return {
    type,
    effect,
    from,
    to,
    method,
    onward,
    origin: row.transfer_origin,
    source,
    requestedBy: requestedById ? { adminId: requestedById, name: row.requested_by_name } : null,
    approvedBy: row.approved_by
      ? { adminId: row.approved_by, name: row.approved_by_name, at: at(row.approved_at) }
      : null,
    decidedBy: row.reviewed_by
      ? { adminId: row.reviewed_by, name: row.decided_by_name, at: at(row.reviewed_at) }
      : null,
    deskReason: row.transfer_desk_reason ?? row.payment_desk_reason,
    deskReasonAr: row.transfer_desk_reason_ar ?? row.payment_desk_reason_ar,
    providerEnvironment: row.provider_environment,
    providerFee: amount(row.provider_fee),
    providerNetAmount: amount(row.provider_net_amount),
    providerRequestAmount: amount(row.provider_request_amount),
    providerAmountReceived: amount(row.provider_amount_received),
    requestedAmount: amount(row.requested_amount),
    providerStatus: row.provider_status,
    providerPayoutId: row.provider_payout_id,
    providerSubmittedAt: at(row.provider_submitted_at),
    providerCheckedAt: at(row.provider_checked_at),
  };
}

export type MovementDetails = ReturnType<typeof movementDetails>;

/** The same facts as flat CSV cells, in the order the export appends them. */
export function movementDetailCells(d: MovementDetails) {
  const endText = (end: MovementEnd): string => {
    switch (end.kind) {
      case 'wallet':
        return `${end.walletKind === 'commission' ? 'Commission wallet' : 'Wallet'} ${end.currency ?? ''} ${end.walletNumber ?? ''}`.trim();
      case 'trading_account':
        return `MT5 ${end.login ?? '(no login)'}${end.environment ? ` (${end.environment})` : ''}`;
      case 'external':
        return 'External';
      case 'company':
        return 'Company (desk)';
    }
  };
  return {
    type: d.type,
    effect: d.effect,
    from: endText(d.from),
    to: endText(d.to),
    walletNumber:
      d.from.kind === 'wallet' && d.to.kind === 'wallet'
        ? `${d.from.walletNumber ?? ''} → ${d.to.walletNumber ?? ''}`
        : ((d.from.kind === 'wallet' ? d.from.walletNumber : d.to.walletNumber) ?? null),
    login:
      (d.from.kind === 'trading_account'
        ? d.from.login
        : d.to.kind === 'trading_account'
          ? d.to.login
          : d.onward?.account.login) ?? null,
    origin: d.origin,
    requestedBy: d.requestedBy?.name ?? null,
    approvedBy: d.approvedBy?.name ?? null,
    decidedBy: d.decidedBy?.name ?? null,
    decidedAt: d.decidedBy?.at ?? null,
    deskReason: d.deskReason,
    sourceReference: d.source ? (d.source.reference ?? d.source.transactionId) : null,
    onwardTransfer: d.onward
      ? d.onward.transferId
        ? `${d.onward.transferId} (${d.onward.state ?? 'unknown'})`
        : 'not moved'
      : null,
    providerFee: d.providerFee,
    providerNetAmount: d.providerNetAmount,
    providerRequestAmount: d.providerRequestAmount,
    providerAmountReceived: d.providerAmountReceived,
    providerStatus: d.providerStatus,
    network: d.method?.channelCode ?? null,
    providerPayoutId: d.providerPayoutId,
  };
}

/**
 * The detail columns every money CSV APPENDS (Financial, Transfers) — one definition, so the two
 * files describe a movement the same way the screen does.
 */
export const MOVEMENT_DETAIL_CSV: readonly CsvColumn<{ details: MovementDetails }>[] = [
  { header: 'Type', value: (r) => movementDetailCells(r.details).type },
  { header: 'Effect', value: (r) => movementDetailCells(r.details).effect },
  { header: 'From', value: (r) => movementDetailCells(r.details).from },
  { header: 'To', value: (r) => movementDetailCells(r.details).to },
  { header: 'Wallet number', value: (r) => movementDetailCells(r.details).walletNumber },
  { header: 'MT5 login', value: (r) => movementDetailCells(r.details).login },
  { header: 'Origin', value: (r) => movementDetailCells(r.details).origin },
  { header: 'Requested by', value: (r) => movementDetailCells(r.details).requestedBy },
  { header: 'Approved by', value: (r) => movementDetailCells(r.details).approvedBy },
  { header: 'Decided by', value: (r) => movementDetailCells(r.details).decidedBy },
  { header: 'Decided at', value: (r) => movementDetailCells(r.details).decidedAt },
  { header: 'Desk reason', value: (r) => movementDetailCells(r.details).deskReason },
  { header: 'Source reference', value: (r) => movementDetailCells(r.details).sourceReference },
  { header: 'Onward transfer', value: (r) => movementDetailCells(r.details).onwardTransfer },
  { header: 'Provider fee', value: (r) => movementDetailCells(r.details).providerFee },
  { header: 'Net amount', value: (r) => movementDetailCells(r.details).providerNetAmount },
  {
    header: 'Requested amount',
    value: (r) => movementDetailCells(r.details).providerRequestAmount,
  },
  {
    header: 'Amount received',
    value: (r) => movementDetailCells(r.details).providerAmountReceived,
  },
  { header: 'Provider status', value: (r) => movementDetailCells(r.details).providerStatus },
  { header: 'Network', value: (r) => movementDetailCells(r.details).network },
  { header: 'Payout ID', value: (r) => movementDetailCells(r.details).providerPayoutId },
];
