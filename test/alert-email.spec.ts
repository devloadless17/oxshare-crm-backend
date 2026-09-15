import { Logger } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import { AlertEmailService } from '../src/modules/email/alert-email.service';
import type { EmailService } from '../src/modules/email/email.service';
import { ALERT_KINDS, raiseAlert } from '../src/common/logging/alerts';

/**
 * Alerts reaching a human.
 *
 * `raiseAlert` wrote to stderr and stopped, which is a delivery mechanism only
 * if something reads the drain — and on this deployment nothing does. So
 * `RECONCILIATION_MISMATCH`, the alert that says the ledger and a wallet
 * disagree about how much money exists, reached a console nobody had open.
 *
 * These go through the REAL `raiseAlert`, not a stubbed sink. The registration
 * is the part that was missing, so a test that called the sink directly would
 * pass with the sink unregistered — which is the bug.
 */

type Sent = {
  to: string;
  kind: string;
  severity: string;
  summary: string;
  context: Record<string, string | number> | undefined;
};

describe('page-severity alerts are emailed', () => {
  let sent: Sent[];
  let service: AlertEmailService;
  // Held as a value rather than read back off `logger` at assertion time:
  // `expect(logger.error)` detaches a method from its object, which is the
  // `unbound-method` rule and a real footgun in any assertion that later calls it.
  let errorSpy: MockInstance;
  const logger = new Logger('test');

  const build = (alertEmailTo: string | undefined): AlertEmailService => {
    sent = [];
    const email = {
      sendOpsAlertEmail: (
        to: string,
        kind: string,
        severity: string,
        summary: string,
        context: Record<string, string | number> | undefined,
      ) => {
        sent.push({ to, kind, severity, summary, context });
        return Promise.resolve();
      },
    } as unknown as EmailService;

    const config = {
      get: (key: string) => (key === 'ALERT_EMAIL_TO' ? alertEmailTo : 'test'),
    } as unknown as ConfigService;

    return new AlertEmailService(email, config);
  };

  beforeEach(() => {
    errorSpy = vi.spyOn(logger, 'error').mockImplementation(() => {});
    vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => {});
    vi.spyOn(Logger.prototype, 'log').mockImplementation(() => {});
    service = build('ops@oxshare.test');
    service.onModuleInit();
  });

  afterEach(() => {
    service.onModuleDestroy();
    vi.restoreAllMocks();
  });

  it('emails a page alert, carrying its kind, summary and context', () => {
    raiseAlert(logger, ALERT_KINDS.RECONCILIATION_MISMATCH, 'page', 'Wallet 7 is short 4.00', {
      walletId: '7',
    });

    expect(sent).toHaveLength(1);
    expect(sent[0]?.to).toBe('ops@oxshare.test');
    expect(sent[0]?.kind).toBe(ALERT_KINDS.RECONCILIATION_MISMATCH);
    expect(sent[0]?.summary).toContain('short 4.00');
    expect(sent[0]?.context).toEqual({ walletId: '7' });
  });

  /**
   * `notify` means "reviewed in working hours". An email that arrives for
   * everything is an email nobody reads, and the entire value of this channel is
   * that its arrival means something.
   */
  it('does NOT email a notify alert — that would devalue the channel', () => {
    raiseAlert(logger, ALERT_KINDS.COMMISSION_CLAWBACK_REQUIRED, 'notify', 'A dealer cancelled');
    expect(sent).toHaveLength(0);
  });

  /**
   * The alerts most worth sending are the ones that repeat: reconciliation runs
   * hourly and a mismatch does not fix itself. Without a window, the first real
   * incident buries the one message that matters — a DIFFERENT alert raised
   * during the same incident — under copies of itself.
   */
  it('sends once per kind per window, however many times it is raised', () => {
    for (let i = 0; i < 5; i += 1) {
      raiseAlert(logger, ALERT_KINDS.RECONCILIATION_MISMATCH, 'page', `attempt ${i}`);
    }
    expect(sent).toHaveLength(1);
    expect(sent[0]?.summary).toBe('attempt 0');
  });

  /** Per KIND, so one loud incident cannot mask a different one beside it. */
  it('does not let one noisy kind suppress another', () => {
    raiseAlert(logger, ALERT_KINDS.RECONCILIATION_MISMATCH, 'page', 'balances disagree');
    raiseAlert(logger, ALERT_KINDS.RECONCILIATION_MISMATCH, 'page', 'again');
    raiseAlert(logger, ALERT_KINDS.REFRESH_TOKEN_REUSE, 'page', 'a credential leaked');

    expect(sent.map((s) => s.kind)).toEqual([
      ALERT_KINDS.RECONCILIATION_MISMATCH,
      ALERT_KINDS.REFRESH_TOKEN_REUSE,
    ]);
  });

  it('still writes the log line — the sink is a courtesy, the log is the record', () => {
    raiseAlert(logger, ALERT_KINDS.RECONCILIATION_MISMATCH, 'page', 'Wallet 7 is short');
    expect(errorSpy).toHaveBeenCalledOnce();
  });
});

describe('the alert path cannot break the money path that raised it', () => {
  const logger = new Logger('test');
  let errorSpy: MockInstance;

  beforeEach(() => {
    errorSpy = vi.spyOn(logger, 'error').mockImplementation(() => {});
    vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => {});
    vi.spyOn(Logger.prototype, 'log').mockImplementation(() => {});
  });

  afterEach(() => vi.restoreAllMocks());

  /**
   * `raiseAlert` is called from the reconciliation job, the refresh-token check
   * and the upload validator. Every one of them is doing something more
   * important than telling somebody about it.
   */
  it('a throwing sink does not propagate out of raiseAlert', () => {
    const email = {
      sendOpsAlertEmail: () => {
        throw new Error('SMTP is down');
      },
    } as unknown as EmailService;
    const config = {
      get: (key: string) => (key === 'ALERT_EMAIL_TO' ? 'ops@oxshare.test' : 'test'),
    } as unknown as ConfigService;

    const service = new AlertEmailService(email, config);
    service.onModuleInit();
    try {
      expect(() =>
        raiseAlert(logger, ALERT_KINDS.RECONCILIATION_MISMATCH, 'page', 'balances disagree'),
      ).not.toThrow();
      expect(errorSpy).toHaveBeenCalledOnce();
    } finally {
      service.onModuleDestroy();
    }
  });

  /**
   * Unset is a valid configuration — a developer has no ops address. The boot
   * warning is what stops that silence being mistaken for calm.
   */
  it('registers no sink at all when ALERT_EMAIL_TO is unset', () => {
    const sendOpsAlertEmail = vi.fn();
    const email = { sendOpsAlertEmail } as unknown as EmailService;
    const config = { get: () => undefined } as unknown as ConfigService;

    const service = new AlertEmailService(email, config);
    service.onModuleInit();
    try {
      raiseAlert(logger, ALERT_KINDS.RECONCILIATION_MISMATCH, 'page', 'balances disagree');
      expect(sendOpsAlertEmail).not.toHaveBeenCalled();
    } finally {
      service.onModuleDestroy();
    }
  });
});
