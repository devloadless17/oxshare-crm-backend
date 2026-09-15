import { Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  registerAlertSink,
  unregisterAlertSink,
  type AlertPayload,
  type AlertSink,
} from '../../common/logging/alerts';
import { EmailService } from './email.service';

/**
 * Gets `page`-severity alerts out of the log and into somebody's inbox.
 *
 * ## The gap this closes
 *
 * `raiseAlert` wrote to stderr and stopped. That is a real delivery mechanism
 * when something reads the drain, and nothing does here: the API runs on a
 * Windows box with no log shipper and no documented retention. So
 * `RECONCILIATION_MISMATCH` — the ledger and a wallet disagreeing about how much
 * money exists — and `REFRESH_TOKEN_REUSE` — a session credential presented from
 * somewhere it was not issued — both reached a console nobody had open.
 *
 * ## Why `page` only
 *
 * `notify` means "reviewed in working hours", and an email that arrives for
 * everything is an email nobody reads. The value of this channel is entirely
 * that its arrival means something; the moment a `notify` stream shares it, a
 * real page is one message among forty. `notify` alerts stay in the log, where
 * they are read deliberately rather than pushed.
 *
 * ## Why the dedupe window exists
 *
 * The alerts most worth sending are the ones that repeat. Reconciliation runs
 * hourly and a mismatch does not fix itself; `TRANSFER_STUCK` re-raises on every
 * sweep while a transfer is stuck. Without a window, the first genuine incident
 * fills the ops inbox with copies of itself, and the ONE message that matters —
 * a different alert, raised during the same incident — arrives buried in them.
 *
 * Fifteen minutes, per KIND. Per kind rather than globally, so a reconciliation
 * mismatch cannot mask a refresh-token reuse happening at the same time.
 *
 * In memory, which is the honest scope: this is a single-instance deployment
 * (the bridge's SQLite store already requires that), and a restart re-sending
 * one email is the correct failure. A durable store would be the wrong trade —
 * the whole point of this class is that it must never be a reason a money path
 * fails, and a database write is one more thing that can.
 */
@Injectable()
export class AlertEmailService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(AlertEmailService.name);

  /** kind → epoch ms of the last email sent for it. */
  private readonly lastSentByKind = new Map<string, number>();

  private static readonly DEDUPE_WINDOW_MS = 15 * 60_000;

  /**
   * Held as a field so `unregisterAlertSink` gets the same reference back.
   * A bound method created at registration time could not be removed.
   */
  private readonly sink: AlertSink = (payload) => this.onAlert(payload);

  constructor(
    private readonly email: EmailService,
    private readonly config: ConfigService,
  ) {}

  onModuleInit(): void {
    const to = this.recipient();
    if (!to) {
      /*
       * A warning, once, at boot — not a refusal to start.
       *
       * Alert email is optional by design: a developer running this locally has
       * no ops address and should not have to invent one. But an operator who
       * MEANT to configure it and typo'd the variable name would otherwise get
       * silence that is indistinguishable from "nothing has gone wrong yet",
       * which is the exact failure this whole class exists to fix.
       */
      this.logger.warn(
        'ALERT_EMAIL_TO is not set — page-severity alerts will be logged but not emailed.',
      );
      return;
    }
    registerAlertSink(this.sink);
    this.logger.log(`Page-severity alerts will be emailed to ${to}.`);
  }

  onModuleDestroy(): void {
    unregisterAlertSink(this.sink);
  }

  private recipient(): string | undefined {
    const value = this.config.get<string>('ALERT_EMAIL_TO')?.trim();
    return value === '' ? undefined : value;
  }

  /**
   * Called from inside `raiseAlert`, which is called from inside money paths.
   *
   * Synchronous and returns immediately: the send is started and deliberately
   * not awaited, so a slow SMTP handshake cannot add latency to a wallet write.
   * `sendOpsAlertEmail` swallows its own failures, and the `catch` here is the
   * belt to that braces — an unhandled rejection would take the process down,
   * and a process dying because it could not report a problem is strictly worse
   * than the problem.
   */
  private onAlert(payload: AlertPayload): void {
    if (payload.severity !== 'page') return;

    const to = this.recipient();
    if (!to) return;

    const now = Date.now();
    const last = this.lastSentByKind.get(payload.kind);
    if (last !== undefined && now - last < AlertEmailService.DEDUPE_WINDOW_MS) return;
    this.lastSentByKind.set(payload.kind, now);

    void this.email
      .sendOpsAlertEmail(
        to,
        payload.kind,
        payload.severity,
        payload.summary,
        payload.context,
        this.config.get<string>('NODE_ENV') ?? 'development',
      )
      .catch((error: unknown) => {
        this.logger.error(`Could not email the ${payload.kind} alert: ${String(error)}`);
      });
  }
}
