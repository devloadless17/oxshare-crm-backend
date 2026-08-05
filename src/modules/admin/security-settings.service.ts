import { Injectable, Logger } from '@nestjs/common';
import { ALERT_KINDS, raiseAlert } from '../../common/logging/alerts';
import {
  SECURITY_SWITCHES,
  SecuritySettingsStore,
  type SecuritySwitch,
  type SecuritySwitchRow,
} from '../../store/security-settings.store';
import { Admin } from '../../store/admins.store';
import { AdminAuditService } from './admin-audit.service';
import { ValidationError } from '../../common/errors/domain-errors';

/** What the admin surface is allowed to name, and what it means. */
const SWITCH_LABELS: Record<SecuritySwitch, string> = {
  [SECURITY_SWITCHES.withdrawalOtp]:
    'Email confirmation code on every client withdrawal (FR-CORE-08 / FR-IND-05)',
};

/**
 * The operator's switches for security controls that can legitimately be off.
 *
 * ── WHY THIS IS ALLOWED TO EXIST ───────────────────────────────────────────
 *
 * The withdrawal OTP cannot be exercised by an automated test and is a nuisance
 * before go-live, so the operator needs it off and then on. Refusing to build
 * the switch does not remove that need — it just moves it somewhere worse, like
 * a commented-out line or an env var that differs between two instances of the
 * same service.
 *
 * ── WHY IT IS BUILT LIKE THIS ──────────────────────────────────────────────
 *
 * Because the obvious failure is not that somebody turns it off maliciously. It
 * is that somebody turns it off on a Tuesday for a demo and nobody remembers.
 * Every property here is aimed at that:
 *
 *  - **On by default.** The store answers `true` for a missing row, so a fresh
 *    deploy, a restored backup or a migration that outran its seed all protect
 *    withdrawals. Off is only ever a state somebody put the system into.
 *  - **Master admin only.** Not a grantable permission. Turning off the control
 *    that stands between a stolen session and a client's balance is not a task
 *    to delegate, and RBAC-02's whole point is that a sub-admin holds only what
 *    was explicitly granted.
 *  - **Audited, with before and after.** `who turned this off` has an answer.
 *  - **Alerted while off, on every read.** This is the part that matters. A
 *    settings screen is a place you have to think to look; an alert stream is
 *    something already being watched. Disabling the OTP therefore produces a
 *    continuous signal, not a single event that scrolls away.
 */
@Injectable()
export class SecuritySettingsService {
  private readonly logger = new Logger(SecuritySettingsService.name);

  constructor(
    private readonly store: SecuritySettingsStore,
    private readonly audit: AdminAuditService,
  ) {}

  /**
   * Is this control on?
   *
   * Raises an alert whenever it answers `false`. That is deliberately noisy: the
   * cost is a log line per withdrawal while the OTP is off, and the benefit is
   * that "the OTP has been disabled since August" is impossible to not notice.
   * If the noise ever becomes a problem the answer is to turn the control back
   * on, which is the behaviour this is trying to produce.
   */
  async isEnabled(key: SecuritySwitch): Promise<boolean> {
    const enabled = await this.store.isEnabled(key);
    if (!enabled) {
      raiseAlert(
        this.logger,
        ALERT_KINDS.SECURITY_CONTROL_DISABLED,
        'notify',
        `A security control is DISABLED: ${SWITCH_LABELS[key]}`,
        { control: key },
      );
    }
    return enabled;
  }

  async list(): Promise<Array<SecuritySwitchRow & { label: string }>> {
    const stored = await this.store.list();
    // Every KNOWN switch is returned, present in the table or not, so the admin
    // screen shows the true state rather than an empty list on a fresh install.
    return Object.values(SECURITY_SWITCHES).map((key) => {
      const row = stored.find((r) => r.key === key);
      return {
        key,
        enabled: row?.enabled ?? true,
        updatedBy: row?.updatedBy ?? null,
        updatedAt: row?.updatedAt ?? new Date(),
        label: SWITCH_LABELS[key],
      };
    });
  }

  async set(key: string, enabled: boolean, actor: Admin): Promise<SecuritySwitchRow> {
    // The key comes off the wire; an unknown one is a typo or a probe, and
    // either way must not create a row nothing reads.
    if (!Object.values(SECURITY_SWITCHES).includes(key as SecuritySwitch)) {
      throw new ValidationError(`Unknown security control: ${key}.`);
    }
    const known = key as SecuritySwitch;

    const before = await this.store.get(known);
    const row = await this.store.set(known, enabled, actor.id);

    this.audit.record(actor.id, 'security.control.set', 'security_setting', known, {
      control: known,
      from: before.enabled,
      to: enabled,
    });

    if (!enabled) {
      // Once, loudly, at the moment of the decision — separate from the ongoing
      // alert in `isEnabled`, because "who did this and when" is a different
      // question from "is it still off".
      raiseAlert(
        this.logger,
        ALERT_KINDS.SECURITY_CONTROL_DISABLED,
        'page',
        `${actor.email} DISABLED a security control: ${SWITCH_LABELS[known]}`,
        { control: known, actorId: actor.id },
      );
    } else {
      this.logger.log(`${actor.email} re-enabled the ${known} security control`);
    }

    return row;
  }
}
