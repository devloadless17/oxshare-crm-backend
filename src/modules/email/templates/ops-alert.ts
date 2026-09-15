import { esc, layout, p, panel, type RenderedEmail } from './layout';

/**
 * An operational alert, addressed to whoever runs this system.
 *
 * ## This is the one template that is not for a client
 *
 * Everything else in this folder is product copy, written so a person reading it
 * on a phone understands what happened to their money. This one is read by
 * somebody who has to decide whether to get out of bed, so it optimises for a
 * different thing: the KIND and the SUMMARY come first and unadorned, because a
 * subject line and a first paragraph are all that is visible in a notification.
 *
 * It keeps the shared layout anyway. An operator seeing the same card their
 * clients see knows immediately that mail is working end to end — and a
 * plain-text alert from a system whose other mail is branded reads like a
 * phishing attempt, which is the response you least want to a real page.
 *
 * ## The context table is deliberately not PII
 *
 * `raiseAlert`'s own contract says context is never PII and never a credential.
 * This renders whatever it is given, escaped, so that contract is the only thing
 * keeping identity data out of an ops inbox — which is where it belongs, at the
 * source, rather than in a filter here that would have to be kept in step.
 */
export function opsAlert(
  kind: string,
  severity: 'page' | 'notify',
  summary: string,
  context: Record<string, string | number> | undefined,
  environment: string,
): RenderedEmail {
  const rows = Object.entries(context ?? {});

  return {
    /*
     * The severity and the kind, in the subject, in that order.
     *
     * A mail client shows perhaps forty characters on a lock screen. "OxShare
     * alert" spends all of them saying nothing — the reader still has to open it
     * to learn whether it can wait until morning, which on a `notify` is a
     * person woken up for nothing and on a `page` is minutes lost.
     */
    subject: `[${severity.toUpperCase()}] ${kind} — OxShare ${environment}`,
    html: layout(
      severity === 'page' ? 'Something needs attention now' : 'Something needs a look',
      [
        p(summary),
        panel(
          `<strong>Alert:</strong> ${esc(kind)}<br>` +
            `<strong>Severity:</strong> ${esc(severity)}<br>` +
            `<strong>Environment:</strong> ${esc(environment)}<br>` +
            `<strong>Raised:</strong> ${esc(new Date().toISOString())}`,
        ),
        rows.length > 0
          ? panel(
              rows
                .map(([key, value]) => `<strong>${esc(key)}:</strong> ${esc(String(value))}`)
                .join('<br>'),
            )
          : '',
        /*
         * Says the thing an operator would otherwise have to remember.
         *
         * An alert that repeats every fifteen minutes and one that fired once
         * are different situations, and the difference is invisible from a
         * single message. Without this line, silence after one email reads as
         * "resolved" when it may equally mean "deduplicated".
         */
        `        <p style="font-size: 12px; color: #6b7280;">Alerts of the same kind are ` +
          `sent at most once every 15 minutes. The full record, including any suppressed ` +
          `repeats, is in the server log.</p>`,
      ]
        .filter(Boolean)
        .join('\n'),
    ),
  };
}
