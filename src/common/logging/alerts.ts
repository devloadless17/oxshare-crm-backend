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
  /**
   * Object storage refused or timed out — documents cannot be STORED or SERVED.
   *
   * The sibling of RECONCILIATION_UNAVAILABLE, and absent for the same reason it
   * was: a dependency being down produces a 500 per request and no statement
   * anywhere that the dependency is the cause. `/health/ready` probes the driver
   * and would show it, but only to something that polls — and the people who
   * find out first are clients stuck part-way through onboarding.
   */
  STORAGE_UNAVAILABLE: 'storage.unavailable',
  /**
   * A registration arrived with a referral code that resolved to no partner.
   *
   * The client is registered either way — refusing a signup over a mangled link
   * is worse than losing the attribution — so without this the introduction is
   * lost silently and permanently, and the only trace was a log line.
   */
  REFERRAL_CODE_UNRESOLVED: 'ib.referral_code_unresolved',
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
  /**
   * Somebody uploaded a PDF carrying active content to the KYC queue.
   *
   * The file was REFUSED, so nothing is on disk and nothing is at risk. The
   * alert exists because of what it says about the uploader: an identity
   * document has no reason to contain a script or an embedded file, so this is
   * either a client whose exporter did something odd — worth knowing, because
   * they cannot finish onboarding until somebody tells them what to do — or
   * somebody testing what the upload endpoint accepts.
   */
  UPLOAD_ACTIVE_CONTENT: 'uploads.active_content',
  /**
   * Clients' identity records (documents, selfie, verification decisions) were
   * out of step with their KYC rows at boot.
   *
   * Until the identity-core contract slice, everything current writes both in
   * one transaction. Code from BEFORE the record writes the KYC rows only, so
   * this means an older build ran on this database since the last boot — a
   * rollback — or somebody edited it by hand. The boot repairs what it can;
   * a client it could NOT repair is named in the log, and from the slice that
   * reads the record their documents read as they were before. `notify`,
   * because nothing is lost: the KYC rows still hold everything.
   */
  IDENTITY_RECORD_DRIFT: 'identity.record_drift',
  /**
   * A promise rejected with nobody listening. The process KEEPS RUNNING.
   *
   * Always a defect rather than an attack in itself, but it is raised at `page`
   * because the alternative is invisibility: the fire-and-forget calls that can
   * land here are notifications and emails, so nothing a user does looks wrong
   * afterwards, and the only symptom is work that silently did not happen.
   */
  UNHANDLED_REJECTION: 'process.unhandled_rejection',
  /**
   * A synchronous throw reached the top. The process is EXITING.
   *
   * With a restart policy in front, this is otherwise completely silent — the
   * API returns in seconds and the only evidence is a gap. An input that
   * reliably triggers it is a denial of service that reports itself as uptime.
   */
  UNCAUGHT_EXCEPTION: 'process.uncaught_exception',
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

  /*
   * ...and then out of the process, to anything that has registered.
   *
   * Everything above writes to a log DRAIN, which is a real delivery mechanism
   * only if something is reading it. On this deployment nothing was: the API
   * runs on a Windows box with no log shipper, so `RECONCILIATION_MISMATCH` —
   * the ledger and a balance disagreeing about how much money exists — reached
   * a console nobody had open.
   *
   * Sinks run AFTER the log line and can never prevent it. That order is the
   * contract: the log is the record, a sink is a courtesy, and a mail server
   * being down must not be able to erase the only trace of a money alert.
   */
  for (const sink of sinks) {
    try {
      sink(payload);
    } catch {
      /*
       * A sink that throws is swallowed, deliberately and silently.
       *
       * `raiseAlert` is called from inside money paths — the reconciliation job,
       * the refresh-token check, the upload validator. Every one of them is
       * doing something more important than telling somebody about it, and a
       * failing mail transport must never become the reason a wallet write
       * unwinds.
       *
       * Not re-raised as an alert either: a sink that fails on every alert would
       * then raise an alert per alert, and the first reconciliation mismatch
       * would become an infinite loop.
       */
    }
  }
}

/**
 * Somewhere an alert should also go — email, a pager, a webhook.
 *
 * Receives the payload AFTER it has been logged. Must not throw (it is caught
 * anyway), must not block, and must never call `raiseAlert` itself.
 */
export type AlertSink = (payload: AlertPayload) => void;

const sinks: AlertSink[] = [];

/**
 * Register a destination for alerts.
 *
 * A module-level registry rather than Nest DI, and that is the whole reason this
 * shipped as a small change: `raiseAlert` has SIXTEEN call sites, several of
 * them in pure functions and static contexts that have no injector. Threading a
 * service through all of them would have meant touching the commission engine
 * and the reconciliation job to deliver an email — a refactor of the money path
 * in service of a notification, which is the wrong way round.
 *
 * Idempotent on the same function reference, so a module that initialises twice
 * (a test app rebuilt per suite) does not double-send.
 */
export function registerAlertSink(sink: AlertSink): void {
  if (!sinks.includes(sink)) sinks.push(sink);
}

/** Remove a sink — used by tests, and by a module shutting down. */
export function unregisterAlertSink(sink: AlertSink): void {
  const at = sinks.indexOf(sink);
  if (at >= 0) sinks.splice(at, 1);
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
  [ALERT_KINDS.REFERRAL_CODE_UNRESOLVED]: {
    severity: 'notify',
    rule: 'Any occurrence is worth reading; a REPEAT of the same code is the one to act on, because it means a link is published somewhere whose code resolves to nobody and every client arriving through it registers unattributed. NOTIFY rather than page — the client is registered and no money has moved wrongly — but attribution is permanent per client and the repair is manual (PATCH /admin/clients/:id/referrer), so the longer it runs the more rows a human fixes by hand. The payload carries the code AS RECEIVED and the normalised form, which usually separates a corrupted link from a partner whose account is gone.',
  },
  [ALERT_KINDS.STORAGE_UNAVAILABLE]: {
    severity: 'notify',
    rule: 'A burst rather than a single occurrence — one timeout is a slow object-store round trip and resolves itself. Sustained, it means KYC and deposit-proof uploads are failing: clients cannot finish onboarding, reviewers cannot open the documents already held, and every one of those is a 500 that names nothing. NOTIFY rather than page because no money moves and nothing is corrupted — the ledger and the wallets are untouched — but it blocks the funnel, so it is answered the same working day rather than the next sprint. Read it beside /health/ready, which reports the same dependency as a state rather than as an event.',
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
  [ALERT_KINDS.UPLOAD_ACTIVE_CONTENT]: {
    severity: 'notify',
    rule: 'Any occurrence. NOTIFY rather than page, and the distinction is the whole point of the two levels: the upload was refused at the door, so nothing is stored, nothing is running and nobody is losing money — there is no 3am action. What there IS is a person, either a client stuck on onboarding with a document they think is fine, or somebody probing the endpoint; both are answered in working hours. If it repeats from one account, read it as probing rather than as a bad exporter.',
  },
  [ALERT_KINDS.IDENTITY_RECORD_DRIFT]: {
    severity: 'notify',
    rule: 'Any occurrence at boot. After a deliberate rollback it is expected once — the context counts what was repaired, by kind — and needs only a note that the rollback happened. Without one, somebody wrote the KYC rows directly: find out who. `failed` above zero is the part to act on: those clients are named in the log, their KYC rows still hold everything, and each boot retries them; fix the cause the log gives and the next boot repairs them.',
  },
  [ALERT_KINDS.UNHANDLED_REJECTION]: {
    severity: 'page',
    rule: 'Any occurrence. The process survives, so nothing looks broken from outside — which is exactly why it pages: the work that was dropped was a notification, an email or an audit row, and none of those announce their own absence. Repeats mean a live defect on a hot path; a single one still names a promise nobody was awaiting.',
  },
  [ALERT_KINDS.UNCAUGHT_EXCEPTION]: {
    severity: 'page',
    rule: 'Any occurrence. The process is exiting and the restart policy will bring it back within seconds, which is precisely the problem: without this alert a repeatable crash reads as uptime. If it repeats, treat the triggering request as an active denial of service and find the input before tuning anything.',
  },
};
