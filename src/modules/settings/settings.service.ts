import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { sealSecret } from '../../common/security/secret-box';
import { AppSettingsStore } from '../../store/app-settings.store';
import { AdminAuditService } from '../admin/admin-audit.service';
import type { Actor } from '../../common/security/actor';
import type {
  SmtpSettingsDto,
  TradingSettingsDto,
  UpdateSmtpSettingsDto,
  UpdateTradingSettingsDto,
} from './dto/settings.dto';
import { tradingTermsFrom } from '../../common/trading-terms';
import { revenueBasisOf } from '../../common/revenue-basis';

/**
 * Reads and writes the two singleton settings rows.
 *
 * ── This class seals; it never opens ───────────────────────────────────────
 *
 * It imports `sealSecret` and deliberately not `openSecret`. Turning stored
 * ciphertext back into a password happens in exactly one place —
 * `SmtpConfigService`, on the path to the mail transport — and keeping the two
 * directions in separate classes is what makes "who can read the SMTP password"
 * answerable by looking at imports rather than by reading every method.
 *
 * ── With no row, the form is BLANK ─────────────────────────────────────────
 *
 * `getSmtp` with no row returns empty fields with `source: 'environment'`.
 * There is no SMTP_* environment configuration left to pre-fill from, so blank
 * is the honest answer: nothing is configured, and this screen is where that
 * gets fixed.
 */
@Injectable()
export class SettingsService {
  constructor(
    private readonly store: AppSettingsStore,
    private readonly config: ConfigService,
    private readonly audit: AdminAuditService,
  ) {}

  async getSmtp(): Promise<SmtpSettingsDto> {
    const row = await this.store.getSmtp();
    if (!row) {
      /*
       * No row means nothing is configured, full stop — there is no longer an
       * environment fallback to report. A blank form is the truth here, and
       * this read must NOT refuse: the settings screen is the only place the
       * unconfigured state can be fixed, so 503-ing it would close the door on
       * the fix. `source` stays 'environment' because it is the DTO's word for
       * "not from the database" and both frontends read it.
       */
      return {
        host: '',
        port: 587,
        username: null,
        passwordSet: false,
        fromAddress: '',
        secure: false,
        source: 'environment',
        updatedAt: null,
      };
    }

    return {
      host: row.host,
      port: row.port,
      username: row.username,
      passwordSet: row.passwordCiphertext !== null,
      fromAddress: row.fromAddress,
      secure: row.secure,
      source: 'database',
      updatedAt: row.updatedAt.toISOString(),
    };
  }

  async setSmtp(dto: UpdateSmtpSettingsDto, actor: Actor): Promise<SmtpSettingsDto> {
    const adminId = actor.id;
    const previous = await this.getSmtp();
    /*
     * The three-state password, resolved once here:
     *
     *   undefined / null  → leave the stored value alone   (undefined to the store)
     *   ''                → remove it                      (null to the store)
     *   'secret'          → replace it                     (ciphertext to the store)
     *
     * The middle case is why this is not a simple `dto.password ? seal : null`:
     * that expression maps both "not touching it" and "remove it" to null and
     * silently wipes a working credential whenever an operator edits the port.
     */
    let passwordCiphertext: string | null | undefined;
    if (dto.password === undefined || dto.password === null) {
      passwordCiphertext = undefined;
    } else if (dto.password === '') {
      passwordCiphertext = null;
    } else {
      passwordCiphertext = sealSecret(dto.password, this.config.get<string>('APP_ENCRYPTION_KEY'));
    }

    const row = await this.store.setSmtp(
      {
        host: dto.host.trim(),
        port: dto.port,
        username: emptyToNull(dto.username),
        fromAddress: dto.fromAddress.trim(),
        secure: dto.secure,
        passwordCiphertext,
      },
      adminId,
    );

    /*
     * ── THE PASSWORD IS NEVER RECORDED, in any form ──────────────────────────
     *
     * Not the plaintext, not the ciphertext, not a prefix, not a length. The
     * audit log is append-only by trigger and readable by any unrestricted
     * admin, so a credential written here is a credential that cannot be
     * revoked from it and is visible to more people than the SMTP form is. This
     * class deliberately imports `sealSecret` and not `openSecret` for the same
     * reason — see the class comment.
     *
     * What IS recorded is that the password CHANGED and in which direction —
     * replaced, removed, or left alone. That is the fact an auditor needs
     * ("was the mail relay's credential rotated on the day those invites went
     * out"), and it carries none of the secret.
     *
     * The rest — host, port, from address, TLS — is where mail is SENT, not how
     * it authenticates, and repointing it is the takeover path this action
     * exists to make attributable: whoever controls the relay receives every
     * password-reset and admin-invite link this system sends.
     */
    const passwordChange =
      dto.password === undefined || dto.password === null
        ? 'unchanged'
        : dto.password === ''
          ? 'removed'
          : 'replaced';

    const changed: Record<string, { before: unknown; after: unknown }> = {};
    if (previous.host !== row.host) changed['host'] = { before: previous.host, after: row.host };
    if (previous.port !== row.port) changed['port'] = { before: previous.port, after: row.port };
    if (previous.username !== row.username) {
      changed['username'] = { before: previous.username, after: row.username };
    }
    if (previous.fromAddress !== row.fromAddress) {
      changed['fromAddress'] = { before: previous.fromAddress, after: row.fromAddress };
    }
    if (previous.secure !== row.secure) {
      changed['secure'] = { before: previous.secure, after: row.secure };
    }

    this.audit.record(actor.id, 'settings.smtp.update', 'app_settings', 'smtp', {
      changed,
      passwordChange,
      // Whether a credential is configured at all — a boolean, not the value.
      passwordSet: row.passwordCiphertext !== null,
      // 'environment' → 'database' is itself notable: the first save takes the
      // relay's configuration out of the deployment and into the table.
      previousSource: previous.source,
    });

    return {
      host: row.host,
      port: row.port,
      username: row.username,
      passwordSet: row.passwordCiphertext !== null,
      fromAddress: row.fromAddress,
      secure: row.secure,
      source: 'database',
      updatedAt: row.updatedAt.toISOString(),
    };
  }

  /* ── Trading ──────────────────────────────────────────────────────────── */

  async getTrading(): Promise<TradingSettingsDto> {
    const row = await this.store.getTrading();
    const terms = tradingTermsFrom(row);

    return {
      maxLiveAccounts: terms.maxLiveAccounts,
      maxDemoAccounts: terms.maxDemoAccounts,
      maxDemoDeposit: terms.maxDemoDeposit,
      ibMaxRevenueSharePct: terms.ibMaxRevenueSharePct,
      ibCommissionHoldHours: terms.ibCommissionHoldHours,
      ibAccrualStart: terms.ibAccrualStart,
      ibRevenueBasis: terms.ibRevenueBasis,
      updatedAt: row?.updatedAt.toISOString() ?? null,
    };
  }

  async setTrading(dto: UpdateTradingSettingsDto, actor: Actor): Promise<TradingSettingsDto> {
    const previous = await this.getTrading();

    /*
     * The LEVERAGE LADDER is not here any more.
     *
     * It was a CSV on this row, parsed strictly and re-formatted on every save.
     * It is the `leverages` table now (migration 0067), with its own screen and
     * its own audit actions — a rung can be withdrawn without touching the
     * accounts opened on it, which is what a delimited string could not say.
     */
    const row = await this.store.setTrading(
      {
        maxLiveAccounts: dto.maxLiveAccounts,
        maxDemoAccounts: dto.maxDemoAccounts,
        maxDemoDeposit: dto.maxDemoDeposit,
        ibMaxRevenueSharePct: dto.ibMaxRevenueSharePct,
        ibCommissionHoldHours: dto.ibCommissionHoldHours,
        /*
         * `undefined` means the caller did not send the field, which must not
         * silently clear a decision somebody already made — a form that predates
         * this field would otherwise reset the engine to HOLDING on every save.
         * Explicit `null` is a real value and does clear it.
         */
        ibAccrualStart:
          dto.ibAccrualStart === undefined ? previous.ibAccrualStart : dto.ibAccrualStart,
        /*
         * Same preserve-on-`undefined` contract as the field above, and the
         * one below it in consequence. This form is a full replace, so a
         * console that predates the field sends every OTHER value on every
         * save — and defaulting a missing basis would re-price the entire book
         * as a side effect of somebody adjusting the demo account cap. There
         * is no `null` case: unlike the backlog decision this setting has no
         * undecided state, because the platform is always paying on something.
         */
        ibRevenueBasis:
          dto.ibRevenueBasis === undefined ? previous.ibRevenueBasis : dto.ibRevenueBasis,
      },
      actor.id,
    );

    /*
     * Every field here is a COMMERCIAL control, so every change is recorded
     * with both sides. Raising the demo ceiling or the account cap is the kind
     * of change that gets noticed a month later in the broker's own reporting,
     * and "who set this to a million and when" needs an answer.
     */
    const after: TradingSettingsDto = {
      maxLiveAccounts: row.maxLiveAccounts,
      maxDemoAccounts: row.maxDemoAccounts,
      maxDemoDeposit: row.maxDemoDeposit,
      ibMaxRevenueSharePct: row.ibMaxRevenueSharePct,
      ibCommissionHoldHours: row.ibCommissionHoldHours,
      ibAccrualStart: row.ibAccrualStart,
      ibRevenueBasis: revenueBasisOf(row.ibRevenueBasis),
      updatedAt: row.updatedAt.toISOString(),
    };

    const changed: Record<string, { before: unknown; after: unknown }> = {};
    for (const field of [
      'maxLiveAccounts',
      'maxDemoAccounts',
      'maxDemoDeposit',
      // The broker's own margin — the single most consequential number here.
      'ibMaxRevenueSharePct',
      // The settlement window. Shortening it to 0 makes every pending
      // accrual payable on the next run, which is a decision with a date on
      // it rather than a preference.
      'ibCommissionHoldHours',
      /*
       * The backlog decision, and the reason this field left the environment.
       * Setting it to "all" can pay months of commission in one run and cannot
       * be undone by a redeploy — so "who decided, when, and from what" has to
       * be answerable, and an environment variable answers none of it.
       */
      'ibAccrualStart',
      /*
       * WHAT a partner is paid on, as against how long it is held or when it
       * starts. This is the field that decides the SIZE of every future
       * accrual, and it was a constant in a source file until now — reachable
       * only by whoever could open a pull request, and recorded nowhere. A
       * partner disputing their statement six months from now is asking a
       * question only this audit row can answer.
       */
      'ibRevenueBasis',
    ] as const) {
      if (previous[field] !== after[field]) {
        changed[field] = { before: previous[field], after: after[field] };
      }
    }
    this.audit.record(actor.id, 'settings.trading.update', 'app_settings', 'trading', { changed });

    return after;
  }
}

/**
 * Treat a blank string as "not set".
 *
 * An operator clearing a field leaves `''`, and storing that would make
 * "configured as empty" and "not configured" two different states the UI has to
 * distinguish for no benefit.
 */
function emptyToNull(value: string | null | undefined): string | null {
  if (value === undefined || value === null) return null;
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}
