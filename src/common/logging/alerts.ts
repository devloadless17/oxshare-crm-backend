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
  /**
   * Trades are queued for commission that nothing is going to pay — refused by
   * the engine, or belonging to an MT5 login no trading account claims.
   *
   * The §9 "failed-job depth" alert this file was written for and the deal
   * queue never had. Its own log line is throttled to once an hour by design,
   * which is right for a log and wrong for the one job on the platform whose
   * silence means partners are not being paid.
   */
  COMMISSION_QUEUE_STALLED: 'money.commission_queue_stalled',
  /**
   * A dealer CANCELLED a trade that has already paid somebody.
   *
   * The engine excludes a cancellation from accruing — `isTradeAction` does not
   * count it — but excluding it says nothing about the accrual already written
   * against the trade it cancels. Nothing else in the system notices: the
   * cancellation is marked done like any other non-trade row, and a partner
   * keeps money earned on a trade that did not happen.
   *
   * Deliberately NOT an automatic clawback. A reversal moves money out of a
   * partner's wallet and that is a decision with a person behind it, not
   * something a feed does because a code arrived. This is how the person finds
   * out — `POST /admin/ib/accruals/:id/reverse` is how they act.
   */
  COMMISSION_CLAWBACK_REQUIRED: 'money.commission_clawback_required',
  /**
   * A client's transfer has been PENDING long enough that something is wrong.
   *
   * The money has not moved — the wallet is debited only once MT5 confirms — so
   * nothing is lost. What is happening is worse in one specific way: the client
   * is looking at "Processing" and has been for a while, with no way to tell
   * whether their money is coming back or going through, and nothing in the
   * system was telling anybody either. It logged a warning after SIX HOURS and
   * that was the whole response.
   *
   * The usual cause is the MT5 bridge having lost its session: every attempt
   * throws MT_RET_ERR_CONNECTION and the resume job retries into a wall. That
   * is exactly the state an operator needs to be told about, because the fix is
   * on the MT5 side and nothing here can reach it.
   */
  TRANSFER_STUCK: 'money.transfer_stuck',
  /** A rotated refresh token was presented again: a credential has leaked. */
  REFRESH_TOKEN_REUSE: 'auth.refresh_reuse',
  /** A signed webhook failed verification — someone is probing an integration endpoint. */
  WEBHOOK_SIGNATURE_FAILURE: 'bridge.signature_failure',
  /** The reconciliation job itself could not run — the ledger is UNCHECKED. */
  RECONCILIATION_UNAVAILABLE: 'reconciliation.unavailable',
  /** An account hit the R-3.5 failure limit and was locked — someone is guessing. */
  LOGIN_LOCKOUT: 'auth.login_lockout',
  /** An operator-controlled security control is switched OFF. */
  SECURITY_CONTROL_DISABLED: 'security.control_disabled',
  /**
   * `TRUSTED_PROXY_HOPS` no longer matches the infrastructure in front of us.
   *
   * The boot line states the number, but a boot line only describes the moment
   * it was written — and the likeliest failure is a CDN added months later by
   * somebody who does not know the variable exists.
   */
  PROXY_DEPTH_MISMATCH: 'security.proxy_depth_mismatch',
  /**
   * Rival and the CRM disagree about a money movement — a deposit PAID there
   * against a terminal row here, a reversal of settled funds, a payout state
   * that contradicts ours. Money is sitting on the wrong side of a boundary
   * until a human reconciles the two dashboards.
   */
  PAYMENT_STATE_MISMATCH: 'payments.state_mismatch',
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
  [ALERT_KINDS.COMMISSION_CLAWBACK_REQUIRED]: {
    severity: 'notify',
    rule: 'Any occurrence: a dealer cancelled a trade that has already accrued. Notify rather than page because nothing is broken and nothing is bleeding — the money has already been paid, and one more night makes no difference to a decision a person has to make in working hours anyway. What it MUST NOT do is get muted: no automatic clawback exists by design, so this alert is the only thing that will ever say a partner is holding money for a trade that did not happen. Reverse it with POST /admin/ib/accruals/:id/reverse; if the partner has already withdrawn it, the reversal refuses and the recovery is a conversation.',
  },
  [ALERT_KINDS.COMMISSION_QUEUE_STALLED]: {
    severity: 'notify',
    rule: 'Raised while deals sit un-accruable: more than 10 the engine REFUSED, or more than a batch (200) belonging to unlinked MT5 logins. Repeats hourly while it holds, and its DISAPPEARANCE is the resolution. Notify rather than page because both fixes are working-hours actions by a human — correct a rate, or link an account — and neither is faster at 3am. Escalate if it survives a working day: every hour it stands is commission earned and unpaid.',
  },
  [ALERT_KINDS.TRANSFER_STUCK]: {
    severity: 'page',
    rule: 'Any transfer pending for more than 15 minutes. PAGE rather than notify, unlike the other money alerts here: a client is watching a spinner on their own money right now, and every other alert in this file is about something a person can look at tomorrow. Nothing is lost — the wallet is debited only after MT5 confirms — but "your $1,000 is somewhere" is not a state to leave somebody in overnight. The usual cause is the MT5 bridge having lost its session, so check GET /admin/live on the bridge first; the resume job retries every minute on its own and clears these the moment MT5 answers.',
  },
  [ALERT_KINDS.REFRESH_TOKEN_REUSE]: {
    severity: 'page',
    rule: 'Any occurrence. A refresh token was replayed, which means a credential left the browser it was issued to.',
  },
  [ALERT_KINDS.WEBHOOK_SIGNATURE_FAILURE]: {
    severity: 'notify',
    rule: 'More than 5 in 5 minutes. One is a misconfigured caller; a burst is someone probing a signed endpoint.',
  },
  [ALERT_KINDS.RECONCILIATION_UNAVAILABLE]: {
    severity: 'notify',
    rule: 'Two consecutive failures. The ledger is not wrong — it is UNCHECKED, which is a different and quieter problem.',
  },
  [ALERT_KINDS.SECURITY_CONTROL_DISABLED]: {
    severity: 'notify',
    rule: 'Any occurrence at `page` severity — an admin has just turned a control off. The `notify` stream repeats for as long as it STAYS off, which is the point: a control disabled "for an afternoon" before go-live is the one that is still off two quarters later. Route the recurring form to a dashboard rather than a pager, and treat its DISAPPEARANCE as the resolution.',
  },
  [ALERT_KINDS.PROXY_DEPTH_MISMATCH]: {
    severity: 'page',
    rule: 'Raised when ~90% of a 200-request sample disagrees with the configured hop count, repeating hourly while it stands. `page` for the SHALLOWER form — the trusted address is then caller-supplied text, so an IP allowlist can be walked through and the rate limiter evaded, which is a live authentication bypass. The DEEPER form is raised at `notify`: every control is keying on our own proxy rather than the caller, which corrupts the audit trail and collapses the limiter but cannot be steered by an attacker. Its disappearance is the resolution.',
  },
  [ALERT_KINDS.LOGIN_LOCKOUT]: {
    severity: 'notify',
    rule: 'One lockout on the ADMIN surface is worth a look; a burst across several admin addresses is a credential-stuffing run in progress against accounts that can approve payouts. On the portal, treat a burst rather than a single occurrence — clients forget passwords.',
  },
  [ALERT_KINDS.PAYMENT_STATE_MISMATCH]: {
    severity: 'page',
    rule: 'Any occurrence. Client money is sitting on the wrong side of the Rival boundary — PAID there against a failed row here, or a reversal of settled funds — and nothing will move it until a human reconciles the two dashboards.',
  },
};
