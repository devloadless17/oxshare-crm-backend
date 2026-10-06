import { Injectable } from '@nestjs/common';
import type { DateRange } from '../../common/date-range';
import { decodeCursor, type CursorPosition } from '../../common/pagination';
import { DEFAULT_AUDIT_SORT } from '../../store/audit-log.store';
import { formatProofDetails } from '../../common/payments/proof-fields';
import { maskAuditRow } from '../../common/security/audit-detail-fields';
import { UsersStore, clientSortKey, clientSortOrder } from '../../store/users.store';
import { ClientTagsStore } from '../../store/client-tags.store';
import { KycStore } from '../../store/kyc.store';
import { AuditLogStore } from '../../store/audit-log.store';
import { IbStore } from '../../store/ib.store';
import { RolesStore } from '../../store/roles.store';
import { AuthorizationError, ValidationError } from '../../common/errors/domain-errors';
import { actorHasPermission, assertActorCan, assertActorCanAny } from '../../common/security/actor';
import { maskForExport } from '../../common/security/mask-by-shape';
import { ClientRowDto, KycSubmissionDto } from './dto/responses.dto';
import {
  FinancialExportRowDto,
  IbApplicationExportRowDto,
  IbPartnerExportRowDto,
  TradingAccountExportRowDto,
  WalletExportRowDto,
  WithdrawalExportRowDto,
} from './dto/export-rows.dto';
import {
  TransactionsService,
  type AdminMovementsFilter,
  type AdminTransactionExportRow,
} from '../payments/transactions.service';
import { AdminHoldingsService } from './admin-holdings.service';
import type { AuthenticatedAdmin } from './guards/admin.guard';
import type { CsvColumn } from '../../common/export/csv';
import {
  assertClientTagExists,
  clientLevelFilter,
  emailVerifiedFilter,
  kycStatusFilter,
  referredFilter,
  withReferrers,
  type ClientRowReferrer,
} from './admin-clients.service';

/**
 * Row sources for the admin table exports.
 *
 * ── What this service is, and what it deliberately is not ───────────────────
 *
 * It is the BATCH FETCHER half of an export: given an actor, the list screen's
 * own filters and an offset, hand back the next slice of rows. The CSV encoding
 * lives in `common/export/csv.ts` and the HTTP framing in
 * `common/export/export-response.ts`; neither is imported here, and this file
 * imports no HTTP types at all, so the layering rule that keeps `HttpException`
 * out of `*.service.ts` holds without an exception.
 *
 * ── The property this file exists to guarantee ──────────────────────────────
 *
 * EVERY method takes the acting admin and passes `actor.clientScope` into the
 * store, in the WHERE clause, exactly as the corresponding list endpoint does.
 * An export that forgot would be the single worst defect available in this
 * feature — a scoped administrator handed a file containing the clients they
 * were specifically denied, silently, with a 200 and no error anywhere.
 * `test/admin-export.spec.ts` drives each of these with a genuinely out-of-scope
 * client and asserts the row is absent.
 *
 * `assertActorCan` is called here as well as in the guard (R-4.3), for the same
 * reason `AdminClientsService.listClients` does it: this method decides WHICH
 * ROWS the caller gets from the actor, so it is making an authorization
 * decision rather than merely receiving one. The guard is a fast reject at the
 * edge, and a future scheduled report calling this directly has no guard at all.
 *
 * ── Why the columns live here beside the fetchers ───────────────────────────
 *
 * A column set and the query that feeds it are one thing: a header that names a
 * field the query stopped selecting is an empty column in an audit artefact,
 * and nothing else in the system would notice. Keeping them adjacent makes that
 * a visible edit rather than a silent one.
 */
/**
 * Where an export stopped, carried between its batches — KEYSET, not offset.
 *
 * Exports used to fetch batch N as `OFFSET N*1000` over a newest-first order.
 * A row inserted while the file streamed (the export writes an audit row
 * itself) shifted every later batch by one, so a row was written twice; and
 * each batch re-walked every row before it. One object per request, created by
 * the controller: the batch methods read `cursor` and leave the next one.
 */
export interface ExportSeek {
  cursor?: CursorPosition;
  /**
   * Set once a batch reports there is nothing after it. Without it, a last batch
   * of EXACTLY the batch size leaves no cursor, `streamCsv` asks once more, and a
   * cursor-less request is page 1 — the file would start over from the top.
   */
  done?: boolean;
}

@Injectable()
export class AdminExportService {
  constructor(
    private readonly users: UsersStore,
    private readonly tags: ClientTagsStore,
    private readonly kyc: KycStore,
    private readonly auditLog: AuditLogStore,
    private readonly ib: IbStore,
    private readonly roles: RolesStore,
    private readonly transactions: TransactionsService,
    /*
     * The wallet and trading-account row sources.
     *
     * APPENDED, and the reason is the one `TransactionsService` records about
     * its own constructor: this class is constructed positionally in parts of
     * the suite, so inserting a parameter in the middle silently shifts every
     * one after it.
     */
    private readonly holdings: AdminHoldingsService,
  ) {}

  // ── Clients ───────────────────────────────────────────────────────────────

  /**
   * The client export's columns.
   *
   * `Tags` is one comma-joined cell rather than a column per tag: the tag
   * vocabulary is operator-editable, so a column-per-tag layout would change
   * shape between two exports taken a week apart and stop being diffable.
   */
  readonly clientColumns: readonly CsvColumn<ClientExportRow>[] = [
    { header: 'Portal ID', value: (r) => r.portalId },
    { header: 'Email', value: (r) => r.email },
    { header: 'First name', value: (r) => r.firstName },
    { header: 'Last name', value: (r) => r.lastName },
    { header: 'Type', value: (r) => r.type },
    { header: 'Status', value: (r) => r.status },
    // The two columns the screen now shows. An export that omitted them would
    // answer "which clients are waiting on verification?" with a file that
    // cannot distinguish an unconfirmed email from a queued document.
    { header: 'Email verified', value: (r) => (r.emailVerified ? 'yes' : 'no') },
    { header: 'KYC status', value: (r) => r.kycStatus },
    { header: 'Verification level', value: (r) => r.verificationLevel },
    { header: 'Country', value: (r) => r.country },
    /*
     * PHONE. It is on the profile response and is maskable in
     * `client-fields.json`, and the file that operators actually work from did
     * not carry it — so "call the clients who registered this week" meant
     * opening each one. It rides the same mask as every other column here.
     */
    { header: 'Phone', value: (r) => r.phone },
    { header: 'Tags', value: (r) => r.tags.map((t) => t.label).join(', ') },
    /*
     * The partner who introduced them — the Referrals page's column, so a file
     * exported from there says whose client each row is. By Portal ID, the
     * number staff search by. Empty for a client nobody introduced, and for a
     * reader without `ib.view` (see `withReferrers`); "outside your territory"
     * for an introducer this reader may not see, never a blank that reads as
     * "not introduced".
     */
    {
      header: 'Introduced by',
      value: (r) => {
        if (!r.referrer) return '';
        if (r.referrer.outsideTerritory) return 'Outside your territory';
        // A masked name leaves the Portal ID, which is never masked.
        const name = [r.referrer.firstName, r.referrer.lastName].filter(Boolean).join(' ');
        return name ? `${r.referrer.portalId} ${name}` : String(r.referrer.portalId);
      },
    },
    { header: 'Registered at', value: (r) => r.createdAt },
  ];

  /**
   * One batch of clients, filtered and scoped exactly as `GET /admin/clients`.
   *
   * The filter parsing is duplicated from `AdminClientsService.listClients` on
   * purpose and only as far as it has to be: an unknown `?tag=` is still a 400
   * rather than an empty file (R-2.5), because "this segment is empty" and "you
   * typed the segment name wrong" must not produce the same artefact. What is
   * NOT duplicated is the row query — that is `UsersStore.findPage`, the same
   * method the list screen calls, with the same scope argument.
   */
  async clientBatch(
    query: ClientExportQuery,
    actor: AuthenticatedAdmin,
    offset: number,
    limit: number,
    seek?: ExportSeek,
  ): Promise<ClientExportRow[]> {
    assertActorCan(actor, 'clients.view', 'export clients');
    if (seek?.done) return [];

    const level = clientLevelFilter(query.level);
    await assertClientTagExists(this.tags, query.tag);

    /*
     * REFUSED when malformed, never ignored — the list's rule, for its reason:
     * an ignored filter is a file of every client under a heading that says it
     * is one partner's book.
     */
    if (query.referredBy !== undefined && !Number.isSafeInteger(query.referredBy)) {
      throw new ValidationError('referredBy must be a client id.');
    }
    const referredBy = query.referredBy || undefined;

    const sort = clientSortKey(query.sort);
    const order = clientSortOrder(query.order);

    const { rows } = await this.users.findPage({
      /*
       * `findPage` computes its offset as `(page - 1) * limit`, so a batch at an
       * arbitrary offset is expressed as a page in a window of that size. The
       * export's batch size is constant, which makes this exact rather than an
       * approximation.
       */
      page: seek ? 1 : Math.floor(offset / limit) + 1,
      cursor: seek?.cursor,
      limit,
      withTotal: false,
      q: query.q?.trim() || undefined,
      type: query.type,
      status: query.status,
      level,
      country: query.country?.trim() || undefined,
      tagSlug: query.tag,
      /*
       * Forwarded, so the file matches the screen it was exported from — and
       * parsed through the SAME functions the list uses, not a second reading of
       * the same strings. `emailVerified` is a tri-state and `kycStatus` refuses
       * an unknown value with a 400 rather than ignoring it; a copy of either
       * here would be one more place for the file and the screen to disagree,
       * which is the defect this whole change is about.
       */
      emailVerified: emailVerifiedFilter(query.emailVerified),
      kycStatus: kycStatusFilter(query.kycStatus),
      referredBy,
      referred: referredFilter(query.referred),
      registered: query.registered,
      sort,
      order,
      // The whole point. Row-level visibility, in the WHERE clause.
      scope: actor.clientScope,
    });

    /*
     * `findPage` fetches `limit + 1` to answer "is there a next page" for the
     * screen. The export pages by offset and does not need that signal, and
     * keeping the extra row would emit one duplicate at every batch boundary.
     */
    const page = rows.slice(0, limit);
    if (seek) {
      const last = page[page.length - 1];
      seek.cursor = last ? { sort, value: last.cursorValue, id: String(last.id) } : undefined;
      seek.done = rows.length <= limit;
    }

    const [tagsByClient, referred] = await Promise.all([
      this.tags.tagsForClients(page.map((r) => r.id)),
      // The same introducer lookup as the list — scoped, one query per batch.
      withReferrers(page, this.users, actor.clientScope, actorHasPermission(actor, 'ib.view')),
    ]);
    const withTags = referred.map((row) => ({ ...row, tags: tagsByClient.get(row.id) ?? [] }));

    /*
     * Field masking applies to a file exactly as it applies to a screen.
     *
     * RBAC-03 lets a role hide client fields — an admin who may not see email
     * addresses on the client list must not be handed a CSV of them. Skipping
     * this would make the export button a documented bypass of the masking
     * feature, which is the same class of defect as skipping the client scope.
     */
    return maskForExport(ClientRowDto, withTags, actor.fieldMask);
  }

  // ── Withdrawals ───────────────────────────────────────────────────────────

  readonly withdrawalColumns: readonly CsvColumn<WithdrawalExportRow>[] = [
    { header: 'Withdrawal ID', value: (r) => r.id },
    /*
     * The amount, as the STRING the database produced.
     *
     * ARCHITECTURE §6.1. No `Number()`, no `toFixed`, no thousands separator:
     * every one of those goes through a float, and a CSV is the output most
     * likely to be re-imported into something that does arithmetic on it.
     */
    { header: 'Amount', value: (r) => r.amount },
    { header: 'Currency', value: (r) => r.currency },
    { header: 'State', value: (r) => r.state },
    { header: 'Portal ID', value: (r) => r.userPortalId },
    { header: 'Client email', value: (r) => r.userEmail },
    { header: 'Client first name', value: (r) => r.userFirstName },
    { header: 'Client last name', value: (r) => r.userLastName },
    { header: 'Provider', value: (r) => r.provider },
    { header: 'Provider reference', value: (r) => r.providerRef },
    { header: 'Destination', value: (r) => r.destination },
    { header: 'Rejection reason', value: (r) => r.rejectionReason },
    { header: 'Requested at', value: (r) => r.requestedAt },
    { header: 'Reviewed at', value: (r) => r.reviewedAt },
    { header: 'Settled at', value: (r) => r.settledAt },
  ];

  async withdrawalBatch(
    query: { state?: string; range?: DateRange },
    actor: AuthenticatedAdmin,
    offset: number,
    limit: number,
    /** The export run's snapshot instant — the SAME value on every batch. */
    startedAt: Date,
  ): Promise<WithdrawalExportRow[]> {
    assertActorCan(actor, 'withdrawals.view', 'export withdrawals');
    const rows = await this.transactions.listForExport({
      startedAt,
      state: query.state,
      range: query.range,
      offset,
      limit,
      scope: actor.clientScope,
    });

    /*
     * The same mask the desk applies — because the route comment one file over
     * says "an export must never be a way around one", and until this line it
     * was exactly that. The KYC export was the same hole and was closed the same
     * way today.
     *
     * The export row is FLAT (`userEmail`) where the desk nests (`user.email`),
     * so it carries its own `withdrawalExport.` prefix rather than sharing the
     * desk's. Sharing one would make the DESK's `maskedFields` announce a flat
     * key that appears on none of the rows it returned — a screen reading it
     * would report a second hidden field that never existed. A CSV has nowhere
     * to put `maskedFields`, so this prefix is invisible and costs nothing.
     *
     * A masked column leaves an EMPTY CELL rather than vanishing, and the header
     * stays. That is deliberate: dropping a column mid-file shifts every later
     * value into the wrong heading, which corrupts the export for anyone who
     * re-imports it. A CSV has nowhere to put `maskedFields`, so the header is
     * the only place left to say the column exists at all.
     */
    return maskForExport(WithdrawalExportRowDto, rows, actor.fieldMask);
  }

  // ── Financial transactions (the platform-wide movement list) ──────────────

  readonly transactionColumns: readonly CsvColumn<AdminTransactionExportRow>[] = [
    { header: 'Transaction ID', value: (r) => r.id },
    /*
     * Kind beside Direction, because the two are read together: 'withdrawal,
     * transfer' is money moving to a trading account, 'withdrawal, payment' is
     * money leaving the platform — and a spreadsheet summing "withdrawals"
     * without the kind column would conflate them.
     */
    { header: 'Kind', value: (r) => r.kind },
    { header: 'Direction', value: (r) => r.direction },
    /*
     * The amount, as the STRING the database produced — §6.1, and the same
     * note as `withdrawalColumns`: a CSV is the output most likely to be
     * re-imported into something that does arithmetic on it.
     */
    { header: 'Amount', value: (r) => r.amount },
    { header: 'Currency', value: (r) => r.currency },
    { header: 'State', value: (r) => r.state },
    { header: 'Portal ID', value: (r) => r.userPortalId },
    { header: 'Client email', value: (r) => r.userEmail },
    { header: 'Client first name', value: (r) => r.userFirstName },
    { header: 'Client last name', value: (r) => r.userLastName },
    { header: 'Method', value: (r) => r.methodName },
    { header: 'Provider', value: (r) => r.provider },
    { header: 'Provider reference', value: (r) => r.providerRef },
    { header: 'Destination', value: (r) => r.destination },
    // What the client gave to identify an offline payment (0163): `Label: value; …`.
    { header: 'Deposit details', value: (r) => formatProofDetails(r.proofDetails) },
    { header: 'Rejection / failure reason', value: (r) => r.rejectionReason },
    { header: 'Created at', value: (r) => r.createdAt },
    { header: 'Settled at', value: (r) => r.settledAt },
  ];

  /**
   * Financial movements, scoped exactly as `GET /admin/transactions`: the
   * batch runs through the same `adminMovements` predicate builder the list
   * uses, scope applied per union arm. R-4.3 asserted here as everywhere in
   * this file — this method decides which rows the caller gets.
   */
  async transactionBatch(
    query: Omit<AdminMovementsFilter, 'scope'>,
    actor: AuthenticatedAdmin,
    limit: number,
    /** The export run's snapshot instant — the SAME value on every batch. */
    startedAt: Date,
    /** The previous batch's last row; the keyset the next batch seeks from. */
    after?: { createdAt: string; id: string },
  ): Promise<AdminTransactionExportRow[]> {
    assertActorCan(actor, 'transactions.view', 'export financial transactions');
    const rows = await this.transactions.listAllForExport({
      ...query,
      limit,
      startedAt,
      after,
      scope: actor.clientScope,
    });
    /*
     * RBAC-03 on the FLAT export shape — its own `financialExport.` prefix,
     * for the reason the withdrawal export's split records: `maskedFields` is
     * a promise about a response's own rows, and the CSV's keys are not the
     * list's. A masked column emits an EMPTY CELL under a kept header — the
     * CSV writer renders the removed field as blank, never a dropped column
     * that shifts every later value under the wrong heading.
     */
    return maskForExport(FinancialExportRowDto, rows, actor.fieldMask);
  }

  // ── Wallets ───────────────────────────────────────────────────────────────

  readonly walletColumns: readonly CsvColumn<WalletExportRow>[] = [
    { header: 'Wallet ID', value: (r) => r.id },
    /*
     * The human handle beside the key — 'Wallet ID' stays because existing
     * reconciliation spreadsheets may already join on it.
     */
    { header: 'Wallet Number', value: (r) => r.walletNumber },
    /*
     * The NAME, beside the number rather than at the end: the two are what an
     * operator reads to identify a row, and a name several columns away from
     * its handle is one nobody lines up.
     *
     * Database-generated from currency and kind, so a spreadsheet says the same
     * thing the console and the portal do.
     */
    { header: 'Wallet Name', value: (r) => r.name },
    /*
     * Balance and hold, as the STRINGS the database produced.
     *
     * ARCHITECTURE §6.1, and a CSV is the output where this matters most: it is
     * the format most likely to be re-imported into a spreadsheet that does
     * arithmetic on it, so a value rounded or locale-formatted on the way out
     * becomes a wrong number in somebody's reconciliation. No `Number()`, no
     * `toFixed`, no thousands separator.
     */
    { header: 'Balance', value: (r) => r.balance },
    { header: 'On hold', value: (r) => r.onHold },
    { header: 'Currency', value: (r) => r.currency },
    /*
     * WHICH wallet — `main` or `commission`.
     *
     * Without it a partner exports as two rows reading "USD" with different
     * balances and nothing telling them apart, and this is the output where
     * that costs most: a CSV is the format most likely to be re-imported into a
     * spreadsheet and summed. An operator reconciling one client's holdings
     * would either double-count or drop a row, with no way to see which.
     *
     * Beside `Currency` rather than at the end, because the two are read
     * together — "USD, commission" is one fact about the row, and splitting it
     * across the first and last columns of a wide sheet is how it gets missed.
     */
    { header: 'Wallet kind', value: (r) => r.kind },
    { header: 'Portal ID', value: (r) => r.userPortalId },
    { header: 'Client email', value: (r) => r.userEmail },
    { header: 'Client first name', value: (r) => r.userFirstName },
    { header: 'Client last name', value: (r) => r.userLastName },
    { header: 'Opened at', value: (r) => r.createdAt },
    { header: 'Updated at', value: (r) => r.updatedAt },
  ];

  /**
   * Wallets, scoped exactly as `GET /admin/wallets`.
   *
   * `AdminHoldingsService.walletExportBatch` builds its predicate with the same
   * `clientScopePredicate` call on the same `wallets.user_id` column the list
   * uses, and asserts the same permission there as well as in the guard. An
   * export that scoped less than its list would be a documented way around the
   * feature — the defect `test/admin-export.spec.ts` exists to catch.
   */
  async walletBatch(
    query: { userId?: number; currency?: string },
    actor: AuthenticatedAdmin,
    offset: number,
    limit: number,
    /** The export run's snapshot instant — the SAME value on every batch. */
    startedAt: Date,
  ): Promise<WalletExportRow[]> {
    assertActorCan(actor, 'wallets.view', 'export client wallets');
    /*
     * The CSV half of the wallet/trading-account exposure. The LIST was masked
     * when that bypass was found; this was not, and it is the more damaging of
     * the two — a file leaves the building with every row in it.
     *
     * A SEPARATE prefix from the desk's, exactly as `withdrawalExport` is:
     * the desk nests the person under `user`, the CSV flattens them to
     * `userEmail`, and one shared prefix would have the desk announce a flat
     * key that appears on none of the rows it returned.
     *
     * Missed on the first pass because this route declares no response schema,
     * so the openapi-driven census could not see it — 42 admin routes are in
     * that blind spot, which is why the census promises completeness over
     * DECLARED schemas and not over routes.
     */
    const rows = await this.holdings.walletExportBatch(query, actor, offset, limit, startedAt);
    return maskForExport(WalletExportRowDto, rows, actor.fieldMask);
  }

  // ── Trading accounts ──────────────────────────────────────────────────────

  readonly tradingAccountColumns: readonly CsvColumn<TradingAccountExportRow>[] = [
    { header: 'Account ID', value: (r) => r.id },
    { header: 'Login', value: (r) => r.login },
    { header: 'MT5 group', value: (r) => r.mt5Group },
    { header: 'Environment', value: (r) => r.environment },
    { header: 'Currency', value: (r) => r.currency },
    // A string, for the same reason the wallet balance is. See above.
    { header: 'Balance', value: (r) => r.balance },
    /*
     * PRODUCT, where `Tier` used to be.
     *
     * `trading_accounts.tier` has never had a writer, so this column was a
     * header above nothing on every export anybody has ever run — and a blank
     * column in a spreadsheet reads as data we lost rather than a field that was
     * never meant to hold anything.
     *
     * `product` answers the question `Tier` was standing in for, and answers it
     * from the account's own `product_id` (0080) rather than from today's
     * catalogue. Blank here means the account genuinely has no product: opened
     * straight into a group the catalogue does not sell.
     */
    { header: 'Product', value: (r) => r.product },
    // Blank means MT5 has never confirmed the balance beside it — which is a
    // different statement from a zero balance, and the column that tells them
    // apart.
    { header: 'Balance synced', value: (r) => r.balanceSyncedAt },
    { header: 'Leverage', value: (r) => r.leverage },
    { header: 'Status', value: (r) => r.status },
    { header: 'Portal ID', value: (r) => r.userPortalId },
    { header: 'Client email', value: (r) => r.userEmail },
    { header: 'Client first name', value: (r) => r.userFirstName },
    { header: 'Client last name', value: (r) => r.userLastName },
    { header: 'MT5 holder name', value: (r) => r.mt5HolderName },
    { header: 'MT5 holder email', value: (r) => r.mt5HolderEmail },
    { header: 'Opened at', value: (r) => r.createdAt },
    { header: 'Updated at', value: (r) => r.updatedAt },
  ];

  async tradingAccountBatch(
    query: { userId?: number; environment?: string; status?: string; client?: string },
    actor: AuthenticatedAdmin,
    offset: number,
    limit: number,
    /** The export run's snapshot instant — the SAME value on every batch. */
    startedAt: Date,
  ): Promise<TradingAccountExportRow[]> {
    assertActorCan(actor, 'trading.view', 'export client trading accounts');
    /*
     * The CSV half of the wallet/trading-account exposure. The LIST was masked
     * when that bypass was found; this was not, and it is the more damaging of
     * the two — a file leaves the building with every row in it.
     *
     * A SEPARATE prefix from the desk's, exactly as `withdrawalExport` is:
     * the desk nests the person under `user`, the CSV flattens them to
     * `userEmail`, and one shared prefix would have the desk announce a flat
     * key that appears on none of the rows it returned.
     *
     * Missed on the first pass because this route declares no response schema,
     * so the openapi-driven census could not see it — 42 admin routes are in
     * that blind spot, which is why the census promises completeness over
     * DECLARED schemas and not over routes.
     */
    const rows = await this.holdings.tradingAccountExportBatch(
      query,
      actor,
      offset,
      limit,
      startedAt,
    );
    // A holder's full name spans two keys; either hidden hides it (see the list).
    const hideName =
      actor.fieldMask.includes('client.firstName') || actor.fieldMask.includes('client.lastName');
    return maskForExport(
      TradingAccountExportRowDto,
      rows.map((row) => (hideName ? { ...row, mt5HolderName: null } : row)),
      actor.fieldMask,
    );
  }

  // ── KYC ───────────────────────────────────────────────────────────────────

  readonly kycColumns: readonly CsvColumn<KycExportRow>[] = [
    { header: 'Portal ID', value: (r) => r.user.portalId },
    { header: 'Client email', value: (r) => r.user.email },
    { header: 'First name', value: (r) => r.user.firstName },
    { header: 'Last name', value: (r) => r.user.lastName },
    { header: 'Status', value: (r) => r.status },
    /*
     * The client's country of residence — the PROFILE's (0139), the one field
     * of the identity the queue shows, and the only one.
     *
     * The queue query selects that one column rather than the profile, so date
     * of birth, address, nationality and phone are not in this result set at
     * all — they cannot leak into the file by accident.
     */
    { header: 'Country', value: (r) => r.personalInfo?.country },
    { header: 'Submitted at', value: (r) => r.submittedAt },
    { header: 'Reviewed at', value: (r) => r.reviewedAt },
    { header: 'Created at', value: (r) => r.createdAt },
    { header: 'Updated at', value: (r) => r.updatedAt },
  ];

  /**
   * KYC submissions, scoped.
   *
   * The store is called directly rather than through `KycReviewService.listAll`,
   * which clamps its limit to 100 — a ceiling that is right for the queue
   * screen and wrong for a file that promises every matching row. The scope
   * argument is the same one `listAll` passes, on the same column.
   *
   * Note what is NOT in the column set: this exports the QUEUE's columns, not
   * the submission. Date of birth, address, nationality, phone and document
   * paths stay out, following the same R-2.5 minimisation the queue query
   * already applies — a reviewer reads those on the detail screen, where doing
   * so is an audited act.
   */
  async kycBatch(
    query: { status?: string; q?: string; range?: DateRange },
    actor: AuthenticatedAdmin,
    offset: number,
    limit: number,
  ): Promise<KycExportRow[]> {
    assertActorCanAny(actor, ['kyc.view', 'kyc.review'], 'export KYC submissions');

    const { items } = await this.kyc.findPageWithUsers({
      status: query.status as KycExportRow['status'] | undefined,
      q: query.q,
      range: query.range,
      page: Math.floor(offset / limit) + 1,
      limit,
      scope: actor.clientScope,
    });
    // The same mask the queue applies (admin-compliance.service.ts). Without
    // it the export was the one KYC surface that handed a masked reviewer the
    // client email — a downloadable copy of exactly what every screen withheld.
    return maskForExport(KycSubmissionDto, items, actor.fieldMask);
  }

  // ── Audit log ─────────────────────────────────────────────────────────────

  readonly auditColumns: readonly CsvColumn<AuditExportRow>[] = [
    { header: 'Recorded at', value: (r) => r.createdAt },
    { header: 'Actor email', value: (r) => r.actorEmail ?? '' },
    // A client actor by Portal ID; an administrator, who has none, by their id.
    { header: 'Actor ID', value: (r) => r.actorPortalId ?? r.actorId },
    { header: 'Actor kind', value: (r) => r.actorKind },
    { header: 'Action', value: (r) => r.action },
    { header: 'Subject type', value: (r) => r.subjectType },
    // A subject that IS a client is named by Portal ID; any other subject (a
    // transaction, a wallet, a role) keeps its own id.
    { header: 'Subject ID', value: (r) => r.subjectPortalId ?? r.subjectId },
    { header: 'Client Portal ID', value: (r) => r.clientPortalId },
    { header: 'IP address', value: (r) => r.ipAddress },
    /*
     * `details` is jsonb and has no fixed shape, so it is serialised whole
     * rather than being spread into columns that would differ per action. The
     * CSV escaping handles the embedded quotes and braces.
     */
    {
      header: 'Details',
      value: (r) => (r.details === undefined ? '' : JSON.stringify(r.details)),
    },
  ];

  /**
   * The admin action log — master admin only, asserted HERE and not merely in
   * the guard.
   *
   * The same check `AdminAuditService.listAuditLog` makes, and for the reason
   * recorded there: master-only is deliberately not expressed as a permission
   * key, because it is not a grant anybody can be given. An export route that
   * checked only its guard would be one decorator away from serving the trail
   * of who acted on which clients to a sub-admin.
   */
  async auditBatch(
    query: {
      action?: string;
      subjectType?: string;
      actorId?: string;
      subjectId?: string;
      q?: string;
      range?: DateRange;
    },
    actor: AuthenticatedAdmin,
    offset: number,
    limit: number,
    seek?: ExportSeek,
  ): Promise<AuditExportRow[]> {
    /*
     * R-4.3: re-asserted here rather than trusted from the route, because this
     * method is reachable from a batch export that never passes through a guard.
     * The key matches the controller's exactly — a stricter check here would
     * authorise the request and then refuse it.
     */
    if (!actorHasPermission(actor, 'audit.view')) {
      throw new AuthorizationError('Reading the admin action log requires audit.view.');
    }
    if (seek?.done) return [];

    const { items, nextCursor } = await this.auditLog.findAll({
      page: seek ? 1 : Math.floor(offset / limit) + 1,
      cursor: seek?.cursor,
      // An export never shows a total; counting per batch was a full scan each.
      withTotal: seek ? false : undefined,
      limit,
      /*
       * Take the batch size literally. Without this the store clamps to
       * MAX_PAGE_SIZE (100), `streamCsv` reads a short batch as the end of the
       * data, and the export stops at 100 of however many rows exist — with no
       * truncation notice, because the notice only fires past MAX_EXPORT_ROWS.
       * Measured before the fix: 100 rows exported out of 1,600.
       */
      unclampedLimit: true,
      action: query.action,
      subjectType: query.subjectType,
      /*
       * EVERY filter the screen has, or the export is a different query wearing
       * the same name. An investigator who narrows to one administrator and
       * then exports must get that administrator's rows — an export that
       * quietly widened back to the whole table would be handed on as evidence
       * of something it does not show.
       */
      actorId: query.actorId,
      subjectId: query.subjectId,
      q: query.q,
      range: query.range,
      // D-54: the export follows the same scope as the list — an export is not
      // a lesser act, and it would otherwise be the way around the filter.
      scope: actor.clientScope,
    });
    if (seek) {
      seek.cursor = nextCursor ? decodeCursor(nextCursor, DEFAULT_AUDIT_SORT) : undefined;
      seek.done = !nextCursor;
    }
    // `findAll` fetches limit + 1 for its cursor; drop the lookahead row.
    /*
     * The CSV half of the audit mask. A file leaves the building carrying every
     * row in it, so this matters more than the screen, not less — and it is the
     * asymmetry that let the withdrawal desk's export leak for seventeen days
     * after its list was fixed.
     *
     * Same declaration as the list read (`audit-detail-fields.ts`), so the two
     * cannot drift: one definition, two call sites.
     */
    return items.slice(0, limit).map((row) => maskAuditRow(row, actor.fieldMask, 'file'));
  }

  // ── IB applications ───────────────────────────────────────────────────────

  readonly ibApplicationColumns: readonly CsvColumn<IbApplicationExportRow>[] = [
    { header: 'Application ID', value: (r) => r.application.id },
    { header: 'Portal ID', value: (r) => r.user.portalId },
    { header: 'Client email', value: (r) => r.user.email },
    { header: 'First name', value: (r) => r.user.firstName },
    { header: 'Last name', value: (r) => r.user.lastName },
    { header: 'Verification level', value: (r) => r.user.verificationLevel },
    { header: 'Status', value: (r) => r.application.status },
    /*
     * The AGENCY, which is what an applicant actually chooses.
     *
     * `Website` and `Motivation` used to sit here and were structurally empty:
     * the apply screen deliberately stopped asking for them (apply-panel.tsx
     * explains why — three questions a reviewer decides from the account
     * anyway, and every field one more reason to abandon), so both columns
     * were headers above nothing on every row. This file already condemned
     * exactly that shape for `Tier`. The agency is the field that IS asked and
     * is required, because it decides what the partner may sell.
     */
    { header: 'Agency', value: (r) => r.agencyName },
    { header: 'Rejection reason', value: (r) => r.application.rejectionReason },
    { header: 'Submitted at', value: (r) => r.application.submittedAt },
    { header: 'Reviewed at', value: (r) => r.application.reviewedAt },
  ];

  async ibApplicationBatch(
    query: { status?: string },
    actor: AuthenticatedAdmin,
    offset: number,
    limit: number,
  ): Promise<IbApplicationExportRow[]> {
    assertActorCan(actor, 'ib.view', 'export partner applications');

    const { rows } = await this.ib.findPageWithUsers({
      status: query.status as IbApplicationExportRow['application']['status'] | undefined,
      page: Math.floor(offset / limit) + 1,
      limit,
      scope: actor.clientScope,
    });
    /*
     * Masked, like every other export on this service.
     *
     * This and `ibPartnerBatch` were the only two of nine batch methods that
     * returned their rows untouched, and both emit `Client email`, `First name`
     * and `Last name` straight off `r.user`. An administrator whose ROLE hides
     * `client.email` was refused it on every screen and handed a CSV of every
     * applicant's address — the export button as a documented bypass of the
     * masking feature, which is the defect `export-rows.dto.ts` was written
     * about after the withdrawal desk did the same thing for seventeen days.
     *
     * The interceptor cannot cover this: the response is a byte stream by the
     * time it exists, which is why every export masks its ROWS instead.
     */
    return maskForExport(IbApplicationExportRowDto, rows, actor.fieldMask);
  }

  // ── IB partners ───────────────────────────────────────────────────────────

  readonly ibPartnerColumns: readonly CsvColumn<IbPartnerExportRow>[] = [
    { header: 'Portal ID', value: (r) => r.user.portalId },
    { header: 'Email', value: (r) => r.user.email },
    { header: 'First name', value: (r) => r.user.firstName },
    { header: 'Last name', value: (r) => r.user.lastName },
    /*
     * The RUNG, which is what decides their terms again (0112). The programme
     * column it replaces answered "who is on what" while programmes existed;
     * a level answers the same question now, and is the only half that is still
     * true of a partner.
     */
    { header: 'Level', value: (r) => r.account.level },
    { header: 'Referral code', value: (r) => r.account.referralCode },
    // The parent's Portal ID — blank when there is none, or when they sit
    // outside the reader's territory (see `IbStore.findPartnersPage`).
    { header: 'Parent partner Portal ID', value: (r) => r.parentPortalId },
    { header: 'Active', value: (r) => r.account.active },
    { header: 'Approved at', value: (r) => r.account.approvedAt },
  ];

  async ibPartnerBatch(
    actor: AuthenticatedAdmin,
    offset: number,
    limit: number,
    /** The directory's own search and state filter, so the file is the list. */
    filter: { q?: string; active?: boolean } = {},
  ): Promise<IbPartnerExportRow[]> {
    assertActorCan(actor, 'ib.view', 'export partners');

    const { rows } = await this.ib.findPartnersPage({
      page: Math.floor(offset / limit) + 1,
      limit,
      scope: actor.clientScope,
      q: filter.q,
      active: filter.active,
    });
    // Same reasoning as `ibApplicationBatch` above.
    return maskForExport(IbPartnerExportRowDto, rows, actor.fieldMask);
  }

  // ── Roles ─────────────────────────────────────────────────────────────────

  readonly roleColumns: readonly CsvColumn<RoleExportRow>[] = [
    { header: 'Role ID', value: (r) => r.id },
    { header: 'Name', value: (r) => r.name },
    { header: 'Description', value: (r) => r.description },
    { header: 'System role', value: (r) => r.isSystem },
    { header: 'Permissions', value: (r) => r.permissions.join(' ') },
    { header: 'Masked fields', value: (r) => r.maskedFields.join(' ') },
    { header: 'Created at', value: (r) => r.createdAt },
  ];

  /**
   * OR semantics, matching `GET /admin/roles` exactly: anyone who can see the
   * admin directory needs the role vocabulary to make sense of it, so requiring
   * `roles.view` alone would deny the export to most of the people who can read
   * the screen it sits on.
   */
  async allRoles(actor: AuthenticatedAdmin): Promise<RoleExportRow[]> {
    if (!actorHasPermission(actor, 'roles.view') && !actorHasPermission(actor, 'admins.view')) {
      throw new AuthorizationError(
        `${actor.email} cannot export roles: the roles.view or admins.view permission is required.`,
      );
    }
    return this.roles.findAll();
  }
}

// ── Row shapes ──────────────────────────────────────────────────────────────
//
// Declared from what the stores actually return rather than imported from the
// list DTOs: a DTO describes the JSON a screen receives, and these are the row
// shapes the queries produce. Tying the export's columns to the DTO would make
// a presentational change to a screen silently reshape an audit artefact.

export interface ClientExportQuery {
  registered?: DateRange;
  q?: string;
  type?: string;
  status?: string;
  level?: string;
  country?: string;
  tag?: string;
  /**
   * The two the controller has always SENT and this interface never declared.
   *
   * `admin-clients.controller.ts` builds the export query with a comment saying
   * "the export honours the SAME filters as the list, so 'export what I am
   * looking at' stays true as filters are added. Omitting these two would have
   * made a filtered screen produce an unfiltered file" — and then passed them
   * into an object typed by this interface, which declared neither, so
   * `clientBatch` never forwarded them.
   *
   * TypeScript could not catch it: the object is bound to a `const` before being
   * passed, which is exactly the case excess-property checking does not cover.
   * So `?kycStatus=rejected` narrowed the screen and returned every client in
   * the file — the promise in that comment inverted, in silence.
   */
  emailVerified?: string;
  kycStatus?: string;
  /**
   * Everyone one partner introduced — the list's `?referredBy=`, already a
   * client id by the time it gets here (`ClientRefPipe` resolves a Portal ID).
   *
   * The same gap as the two above, found the same way: the clients screen
   * filtered by it and the export did not accept it, so "export the clients
   * this partner brought in" produced every client in the scope.
   */
  referredBy?: number;
  /** The Referrals page's `?referred=true` — the file is that page's rows. */
  referred?: string;
  sort?: string;
  order?: string;
}

export interface ClientExportRow {
  /** The Portal ID — the client's id since 0159. */
  id: number;
  /** The Portal ID — what a spreadsheet is filtered by; the UUID is never exported. */
  portalId: number;
  email: string;
  firstName: string;
  lastName: string;
  type: string;
  status: string;
  emailVerified: boolean;
  kycStatus: string;
  verificationLevel: number;
  country: string | null;
  phone: string | null;
  tags: { label: string }[];
  /** Absent when nobody introduced them, or for a reader without `ib.view`. */
  referrer?: ClientRowReferrer;
  createdAt: Date;
}

export interface WithdrawalExportRow {
  id: string;
  /** A STRING, always — see `withdrawalColumns`. */
  amount: string;
  currency: string;
  state: string;
  provider: string;
  providerRef: string | null;
  destination: string | null;
  rejectionReason: string | null;
  requestedAt: Date;
  reviewedAt: Date | null;
  settledAt: Date | null;
  userId: number;
  userPortalId: number;
  userEmail: string;
  userFirstName: string;
  userLastName: string;
}

export interface WalletExportRow {
  id: string;
  /** The human handle — see the `Wallet Number` column. */
  walletNumber: string;
  /** "USD Wallet" / "Commission Wallet" — generated by the database. */
  name: string;
  /** A STRING, always — see `walletColumns`. */
  balance: string;
  /** A STRING, always. */
  onHold: string;
  currency: string;
  /** `main` or `commission` — see the `Wallet kind` column for why it is here. */
  kind: string;
  createdAt: Date;
  updatedAt: Date;
  userId: number;
  userPortalId: number;
  userEmail: string;
  userFirstName: string;
  userLastName: string;
}

export interface TradingAccountExportRow {
  id: string;
  login: string | null;
  mt5Group: string | null;
  environment: string;
  currency: string;
  /** A STRING, always — see `tradingAccountColumns`. */
  balance: string;
  product: string | null;
  balanceSyncedAt: Date | null;
  leverage: number | null;
  status: string;
  createdAt: Date;
  updatedAt: Date;
  /** NULL on an account the MT5 sync found with no client yet (0166). */
  userId: number | null;
  userPortalId: number | null;
  userEmail: string | null;
  userFirstName: string | null;
  userLastName: string | null;
  /** MT5's holder, recorded by the sync — how an unowned account is matched to a client. */
  mt5HolderName: string | null;
  mt5HolderEmail: string | null;
}

export interface KycExportRow {
  userId: number;
  status: 'not_started' | 'in_progress' | 'submitted' | 'under_review' | 'approved' | 'rejected';
  /** Only `country` — see the column note. The rest of the profile is not selected. */
  personalInfo?: { country: string };
  submittedAt?: Date;
  reviewedAt?: Date;
  createdAt: Date;
  updatedAt: Date;
  user: { id: number; portalId: number; email: string; firstName: string; lastName: string };
}

export interface AuditExportRow {
  id: string;
  actorId: string;
  /*
   * OPTIONAL because `maskAuditRow` removes it when the actor is a client and
   * the reader may not see client addresses. Typed `string` here would be the
   * same class of false statement that caused the leak: a declaration that was
   * true when written and is not checked again.
   */
  actorEmail?: string;
  actorKind: string;
  action: string;
  subjectType: string;
  subjectId: string;
  /** The client the row is about — see `AuditEntryDto.clientPortalId`. */
  clientPortalId: number | null;
  /** A client actor's Portal ID — see `AuditEntryDto.actorPortalId`. */
  actorPortalId: number | null;
  /** The subject's Portal ID when the subject IS a client. */
  subjectPortalId: number | null;
  details?: Record<string, unknown>;
  ipAddress: string | null;
  createdAt: Date;
}

export interface IbApplicationExportRow {
  application: {
    id: string;
    userId: number;
    status: 'pending' | 'approved' | 'rejected';
    motivation: string | null;
    website: string | null;
    rejectionReason: string | null;
    submittedAt: Date;
    reviewedAt: Date | null;
  };
  /** Null on an application predating the agency requirement. */
  agencyName: string | null;
  user: {
    id: number;
    portalId: number;
    email: string;
    firstName: string;
    lastName: string;
    verificationLevel: number;
  };
}

export interface IbPartnerExportRow {
  account: {
    userId: number;
    level: number;
    parentIbUserId: number | null;
    referralCode: string;
    active: boolean;
    approvedAt: Date;
  };
  user: { id: number; portalId: number; email: string; firstName: string; lastName: string };
  parentPortalId: number | null;
}

export interface RoleExportRow {
  id: string;
  name: string;
  description?: string;
  permissions: string[];
  maskedFields: string[];
  isSystem: boolean;
  createdAt: Date;
}
