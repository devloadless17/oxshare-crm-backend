import { esc, layout, p, type RenderedEmail } from './layout';

/**
 * "Your SMTP settings work" — the one message that is diagnostics, not product.
 *
 * It reports the host and which configuration answered, so an operator can tell
 * "my saved settings work" from "my settings were never saved and the
 * environment fallback is what delivered". That distinction is the whole reason
 * the endpoint exists.
 *
 * It lives here with the rest so it carries the same logo and card — an admin
 * testing mail should see what a client will see — but note it is the one body
 * a brand change should leave alone: the host and source lines are facts about
 * the configuration, not copy.
 */
export function smtpTest(
  host: string,
  port: number,
  source: 'database' | 'environment',
): RenderedEmail {
  return {
    subject: 'SMTP test — OxShare Admin',
    html: layout(
      'Your SMTP settings work',
      [
        p(
          'This is a test message from the OxShare admin console. If you are reading it, the mail configuration currently saved can deliver.',
        ),
        // Composed rather than passed to `fine()` because the port is a number
        // and the source phrase is chosen, not interpolated user input.
        `        <p style="font-size: 12px; color: #6b7280;">Sent via ${esc(host)}:${port} using the ${
          source === 'database' ? 'saved settings' : 'server environment configuration'
        }.</p>`,
      ].join('\n'),
    ),
  };
}
