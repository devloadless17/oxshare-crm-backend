import { Logger } from '@nestjs/common';

/**
 * The events that should wake somebody up — PLATFORM-CONVENTIONS §12.3.
 *
 * ARCHITECTURE §9 says to "set up alerting on failed-job depth before go-live,
 * not after", and nothing existed. There is no paging provider yet and choosing
 * one is not an engineering decision, so this does the part that IS ours: it
 * makes the signal unambiguous and machine-detectable, so wiring a provider
 * later is a log-drain filter rather than an archaeology exercise.
 *
 * Every alert is one JSON line carrying `alert: true`, a stable `kind`, and a
 * severity. That is the whole contract: whatever eventually watches these greps
 * for `"alert":true` and routes on `kind`. Nothing needs to change here when a
 * provider is chosen.
 *
 * The kinds are a CLOSED set on purpose. An alert taxonomy that anyone can add a
 * free-text kind to becomes unroutable within a month, and the whole point is
 * that a human decided in advance which of these is worth a phone call.
 */
export const ALERT_KINDS = {
  /** The ledger and a balance disagree about how much money exists. */
  RECONCILIATION_MISMATCH: 'reconciliation.mismatch',
  /** Commission earned, confirmed, and never credited. */
  UNPAID_CONFIRMED_ACCRUAL: 'reconciliation.unpaid_accrual',
  /** An accrual exceeded the §12.4 ceiling — almost certainly a wrong spread unit. */
  COMMISSION_CEILING_BREACH: 'money.commission_ceiling',
  /** A rotated refresh token was presented again: a credential has leaked. */
  REFRESH_TOKEN_REUSE: 'auth.refresh_reuse',
  /** Someone is probing the deal feed, which mints commission. */
  WEBHOOK_SIGNATURE_FAILURE: 'bridge.signature_failure',
  /** The reconciliation job itself could not run — the ledger is UNCHECKED. */
  RECONCILIATION_UNAVAILABLE: 'reconciliation.unavailable',
  /** A correctly-signed deal batch that this API could not parse at all. */
  MT5_BATCH_REJECTED: 'bridge.batch_rejected',
} as const;

export type AlertKind = (typeof ALERT_KINDS)[keyof typeof ALERT_KINDS];

/**
 * `page` wakes someone now. `notify` is reviewed in working hours.
 *
 * Stated here rather than left to whoever configures the drain, because the
 * judgement of what is worth a phone call belongs with the code that knows what
 * the event means.
 */
export type AlertSeverity = 'page' | 'notify';

export interface AlertPayload {
  alert: true;
  kind: AlertKind;
  severity: AlertSeverity;
  summary: string;
  /** Never PII, never a credential — the logger redacts, but do not rely on it. */
  context?: Record<string, string | number>;
}

/**
 * Emits one alert line.
 *
 * Takes the caller's own Logger so the `context` field still says which service
 * raised it, and so the line goes through JsonLogger's redaction like everything
 * else (R-6.3).
 */
export function raiseAlert(
  logger: Logger,
  kind: AlertKind,
  severity: AlertSeverity,
  summary: string,
  context?: Record<string, string | number>,
): void {
  const payload: AlertPayload = {
    alert: true,
    kind,
    severity,
    summary,
    ...(context ? { context } : {}),
  };

  // `error` for both severities: an alert is by definition something that should
  // not be happening, and a `page` buried at warn level is one filter mistake
  // away from silence.
  logger.error(payload);
}

/**
 * The thresholds, written down.
 *
 * Not enforced in code — that belongs in whatever watches the drain — but
 * recorded next to the kinds so the decision exists somewhere other than in
 * somebody's memory, which is the state §12.3 describes.
 */
export const ALERT_THRESHOLDS: Record<AlertKind, { severity: AlertSeverity; rule: string }> = {
  [ALERT_KINDS.RECONCILIATION_MISMATCH]: {
    severity: 'page',
    rule: 'Any occurrence. The ledger and a balance disagree; every hour it goes undiagnosed is another hour of writes on top of it.',
  },
  [ALERT_KINDS.UNPAID_CONFIRMED_ACCRUAL]: {
    severity: 'page',
    rule: 'Any occurrence. An IB has earned commission that was never credited.',
  },
  [ALERT_KINDS.COMMISSION_CEILING_BREACH]: {
    severity: 'page',
    rule: 'Any occurrence. Almost certainly the D-11 spread unit; accrual is refused, so deals are accumulating un-accrued until it is fixed.',
  },
  [ALERT_KINDS.REFRESH_TOKEN_REUSE]: {
    severity: 'page',
    rule: 'Any occurrence. A refresh token was replayed, which means a credential left the browser it was issued to.',
  },
  [ALERT_KINDS.MT5_BATCH_REJECTED]: {
    severity: 'page',
    rule: 'Any occurrence. The batch was correctly signed, so it IS our bridge — the two sides disagree about the payload shape. Nothing accrues while this holds, and the symptom is silence rather than errors: the bridge keeps posting, we keep answering 202, and partners go unpaid until somebody notices.',
  },
  [ALERT_KINDS.WEBHOOK_SIGNATURE_FAILURE]: {
    severity: 'notify',
    rule: 'More than 5 in 5 minutes. One is a misconfigured bridge; a burst is someone probing an endpoint that mints commission.',
  },
  [ALERT_KINDS.RECONCILIATION_UNAVAILABLE]: {
    severity: 'notify',
    rule: 'Two consecutive failures. The ledger is not wrong — it is UNCHECKED, which is a different and quieter problem.',
  },
};
