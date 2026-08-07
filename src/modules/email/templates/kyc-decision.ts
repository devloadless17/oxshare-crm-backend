import { button, card, esc, p, panel, type RenderedEmail } from './layout';

/**
 * The KYC verdict — approved, or rejected with what to fix.
 *
 * The heading colour carries the outcome before a word is read, which is why
 * this template composes its own heading markup rather than using `layout`'s.
 *
 * A rejection ALWAYS states a reason and, where the reviewer named them, the
 * specific fields. "Your application needs correction" with no reason is a
 * message the recipient cannot act on, and they will simply resubmit the same
 * documents.
 */
export function kycDecision(
  firstName: string,
  decision: 'approved' | 'rejected',
  portalUrl: string,
  reason?: string,
  rejectedFields?: string[],
): RenderedEmail {
  const approved = decision === 'approved';

  const body = approved
    ? p(
        'Your KYC application has been approved. Your account has been upgraded to verification level 1 and all gated features are now unlocked.',
      )
    : [
        p(
          'Your KYC application has been reviewed and requires corrections before it can be approved.',
        ),
        panel(`<strong>Reason:</strong> ${esc(reason)}`),
        rejectedFields && rejectedFields.length > 0
          ? `        <p><strong>Fields to correct:</strong> ${rejectedFields.map(esc).join(', ')}</p>`
          : '',
        p('Please log in, update the highlighted information, and resubmit.'),
      ]
        .filter(Boolean)
        .join('\n');

  return {
    subject: approved
      ? 'Identity Verified — OxShare'
      : 'Action Required: Your KYC Application Needs Correction — OxShare',
    // `card()` rather than `layout()`, and rather than a hand-rolled wrapper:
    // this is the one template whose heading colour carries meaning, so it
    // composes its own <h2> — but the logo, the card and the footer still come
    // from the shared helper, so it cannot drift from the other messages.
    html: card(`        <h2 style="color: ${approved ? '#047857' : '#b42318'}; margin-top: 0;">
          ${approved ? 'Your identity is verified' : 'Your KYC application needs correction'}
        </h2>
${p(`Hello ${firstName || 'Valued Client'},`)}
${body}
${button(portalUrl, 'Go to Portal')}`),
  };
}
