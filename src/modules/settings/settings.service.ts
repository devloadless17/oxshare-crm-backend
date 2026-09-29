import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { assertPublicOutboundHost } from '../../common/security/outbound-host';
import { sealSecret } from '../../common/security/secret-box';
import { AppSettingsStore } from '../../store/app-settings.store';
import { AdminsStore } from '../../store/admins.store';
import { AdminAuditService } from '../admin/admin-audit.service';
import type { Actor } from '../../common/security/actor';
import type {
  SmtpSettingsDto,
  TradingSettingsDto,
  UpdateSmtpSettingsDto,
  UpdateTradingSettingsDto,
} from './dto/settings.dto';
import { tradingTermsFrom } from '../../common/trading-terms';
import {
  SCHEDULED_JOBS,
  scheduledJob,
  type ScheduledJobDefinition,
} from '../../common/scheduling/scheduled-jobs.catalog';
import { NotFoundError, ValidationError } from '../../common/errors/domain-errors';
import type { ScheduledJobDto, ScheduledJobListDto } from './dto/scheduled-jobs.dto';

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
    /** Resolves `updated_by` to a name. Appended LAST — positional construction. */
    private readonly admins: AdminsStore,
  ) {}

  /**
   * The administrator who last saved a settings row, by NAME.
   *
   * Every save records the id and no screen showed it, so "who changed the
   * commission basis, and when" was answerable only from the audit log. Null
   * for an unsaved row or an administrator since deleted — stated, not
   * guessed.
   */
  private async savedBy(id: string | null | undefined): Promise<string | null> {
    if (!id) return null;
    return (await this.admins.namesByIds([id])).get(id) ?? null;
  }

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
        updatedByName: null,
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
      updatedByName: await this.savedBy(row.updatedBy),
    };
  }

  async setSmtp(dto: UpdateSmtpSettingsDto, actor: Actor): Promise<SmtpSettingsDto> {
    const adminId = actor.id;
    const previous = await this.getSmtp();

    /*
     * The mail host has to be on the public internet.
     *
     * `host` was validated for LENGTH and nothing else, so this field accepted
     * `10.0.0.5`, `127.0.0.1` and `169.254.169.254` — an outbound connect to any
     * address on this server's own network, chosen from a web form.
     *
     * What makes it worth a guard rather than a note is what travels over that
     * connection. Repointing the host does not break mail; it DELIVERS it, to
     * whoever is listening. Every verification link, every password reset, and
     * the admin invite — which `email.service.ts` calls "the most dangerous
     * credential the system sends" — go to the host named here. A silent
     * redirect is worth more to an attacker than an outage, and nothing about
     * the screen afterwards would look wrong.
     *
     * Loopback stays allowed outside production: Mailpit on `localhost:1025` is
     * how every developer reads the mail this system sends.
     */
    await assertPublicOutboundHost(dto.host, {
      subject: 'The SMTP host',
      allowLoopback: this.config.get<string>('NODE_ENV') !== 'production',
    });
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
      updatedByName: await this.savedBy(row.updatedBy),
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
      ibCommissionIntervalSeconds: terms.ibCommissionIntervalSeconds,
      updatedAt: row?.updatedAt.toISOString() ?? null,
      updatedByName: await this.savedBy(row?.updatedBy),
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
        /*
         * The commission CADENCE (0113), which replaced the ladder ceiling on
         * this form. It passes the same test that ceiling did and the four
         * fields 0103/0104 removed did not: it decides WHEN partners are paid,
         * never HOW MUCH — the amounts belong to the IB Levels page alone.
         */
        ibCommissionIntervalSeconds: dto.ibCommissionIntervalSeconds,
        /*
         * ── THE TWO PAYOUT CEILINGS ARE NOT ON THIS FORM (0112) ────────────
         *
         * `ib_max_total_payout_pct` and `ib_max_payout_per_lot` are still
         * enforced, still stored, and still bound every accrual — they are the
         * unit-error backstop `checkPlausible` reads, and removing them would
         * let a rate meaning 70x rather than 70% accrue seventy times the
         * revenue.
         *
         * What went is the CONTROL. They were removed from the form on an
         * explicit instruction, and the columns keep whatever they hold —
         * defaulting to 100% and $50 a lot, both far above any real rate card.
         * A PUT that no longer mentions them therefore leaves them alone
         * rather than resetting them, which is why they are absent here rather
         * than written from a constant.
         */
        /*
         * No other IB fields here (0104). The settlement window, the accrual
         * start, the revenue basis and the broker cap were all removed from this
         * form: commission is configured on the Commission Programmes page, and
         * a Trading-settings control that re-prices every partner is a second
         * place to look when a payout surprises somebody.
         *
         * Which also removes the preserve-on-`undefined` dance those fields
         * needed — a console that predates a field sends every OTHER value on a
         * full-replace save, so a missing one used to risk re-pricing the whole
         * book as a side effect of adjusting the demo account cap.
         */
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
      ibCommissionIntervalSeconds: row.ibCommissionIntervalSeconds,
      updatedAt: row.updatedAt.toISOString(),
      updatedByName: await this.savedBy(row.updatedBy),
    };

    const changed: Record<string, { before: unknown; after: unknown }> = {};
    for (const field of [
      'maxLiveAccounts',
      'maxDemoAccounts',
      'maxDemoDeposit',
      /*
       * The cadence is audited for a sharper reason than the ceiling it
       * replaced. Shortening it does not change what anybody is paid — it
       * removes the window in which a bad trade can be caught BEFORE the
       * commission on it becomes spendable. "Who set this to sixty seconds,
       * and when" is the first question asked after a payout that should have
       * been reviewed.
       */
      'ibCommissionIntervalSeconds',
    ] as const) {
      if (previous[field] !== after[field]) {
        changed[field] = { before: previous[field], after: after[field] };
      }
    }
    this.audit.record(actor.id, 'settings.trading.update', 'app_settings', 'trading', { changed });

    return after;
  }

  // ── Scheduled jobs (0167) — Settings → Scheduled jobs ──────────────────────

  /**
   * Every background job, its interval and its last run. The commission pair
   * shows the ONE Trading-settings interval they share (it is also the hold
   * window), so the two screens can never disagree.
   */
  async listJobs(): Promise<ScheduledJobListDto> {
    const [rows, trading] = await Promise.all([this.store.listJobs(), this.store.getTrading()]);
    const commission = tradingTermsFrom(trading).ibCommissionIntervalSeconds;
    const byKey = new Map(rows.map((row) => [row.key, row]));
    const iso = (at: Date | null | undefined) => (at ? at.toISOString() : null);
    const items: ScheduledJobDto[] = (SCHEDULED_JOBS as readonly ScheduledJobDefinition[]).map(
      (job) => {
        const row = byKey.get(job.key);
        return {
          key: job.key,
          group: job.group,
          runsOn: job.runsOn,
          intervalSeconds: job.sharedInterval
            ? commission
            : (row?.intervalSeconds ?? job.defaultSeconds),
          defaultSeconds: job.defaultSeconds,
          minSeconds: job.min,
          maxSeconds: job.max,
          sharedInterval: job.sharedInterval ?? null,
          lastStartedAt: iso(row?.lastStartedAt),
          lastFinishedAt: iso(row?.lastFinishedAt),
          lastDurationMs: row?.lastDurationMs ?? null,
          lastError: row?.lastError ?? null,
          lastErrorAt: iso(row?.lastErrorAt),
          externalReadAt: iso(row?.externalReadAt),
          running: Boolean(
            row?.lastStartedAt && (!row.lastFinishedAt || row.lastFinishedAt < row.lastStartedAt),
          ),
        };
      },
    );
    return { items };
  }

  /**
   * Change how often a job runs — within its bounds, which are the safe range
   * (`scheduled-jobs.catalog.ts`). The runner applies it within 15 seconds; the
   * bridge within a minute. The commission pair's interval is the Trading
   * setting, changed through `setTrading` so it is audited exactly as there.
   */
  async setJobInterval(key: string, seconds: number, actor: Actor): Promise<ScheduledJobListDto> {
    const job = scheduledJob(key);
    if (!job) throw new NotFoundError(`There is no scheduled job "${key}".`);
    if (!Number.isInteger(seconds) || seconds < job.min || seconds > job.max) {
      throw new ValidationError(
        `This job can run every ${job.min} to ${job.max} seconds; ${seconds} is outside that.`,
      );
    }

    if (job.sharedInterval === 'commission') {
      const current = await this.getTrading();
      await this.setTrading(
        {
          maxLiveAccounts: current.maxLiveAccounts,
          maxDemoAccounts: current.maxDemoAccounts,
          maxDemoDeposit: current.maxDemoDeposit,
          ibCommissionIntervalSeconds: seconds,
        },
        actor,
      );
      return await this.listJobs();
    }

    const before = (await this.store.listJobs()).find((row) => row.key === key);
    await this.store.setJobInterval(key, seconds, actor.id);
    this.audit.record(actor.id, 'settings.jobs.update', 'app_settings', key, {
      intervalSeconds: { before: before?.intervalSeconds ?? job.defaultSeconds, after: seconds },
    });
    return await this.listJobs();
  }

  /**
   * "Run now": the runner starts it at its next tick (within 15 seconds), on
   * whichever instance claims it. Not for the commission pair (their own loop,
   * paced by the hold window) nor a bridge job (the bridge runs it).
   */
  async runJobNow(key: string, actor: Actor): Promise<ScheduledJobListDto> {
    const job = scheduledJob(key);
    if (!job) throw new NotFoundError(`There is no scheduled job "${key}".`);
    if (job.runsOn !== 'crm' || job.sharedInterval) {
      throw new ValidationError(
        job.runsOn === 'bridge'
          ? 'This job runs on the MT5 bridge; it cannot be started from here.'
          : 'Commission runs on its own interval, which is also its hold window; it cannot be started early.',
      );
    }
    await this.store.requestJobRun(key);
    this.audit.record(actor.id, 'settings.jobs.run', 'app_settings', key, {});
    return await this.listJobs();
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
