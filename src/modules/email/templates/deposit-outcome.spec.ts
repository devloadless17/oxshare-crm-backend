import { describe, expect, it } from 'vitest';
import { depositOutcome } from './deposit-outcome';

/**
 * The three sentences a rejected offline deposit MUST and MUST NOT contain.
 *
 * This template is the only place the platform explains a refusal to somebody
 * who has already sent real money, and the whole feature's most dangerous
 * mistake is a single word here: a refund. A withdrawal is DEBITED when it is
 * requested, so refusing one gives the money back. A deposit debits nothing —
 * `requestDeposit` posts no ledger entry — so there is nothing to return, and a
 * sentence promising one describes money that would have to be invented.
 *
 * The risk is not that somebody writes that deliberately. It is that the two
 * flows read as mirror images, and the withdrawal template two files away does
 * promise a reversal. These assertions exist so copying it fails loudly.
 */
describe('depositOutcome, rejected', () => {
  const render = (reason?: string) =>
    depositOutcome('John', 'rejected', '60.00000000', 'USD', 'https://portal.test', reason);

  it('says plainly that nothing was credited', () => {
    expect(render().html).toContain('nothing has been added to');
  });

  it('never promises a refund, a reversal or a return', () => {
    const { html, subject } = render('Receipt unreadable');
    expect(`${subject} ${html}`.toLowerCase()).not.toMatch(
      /refund|reversed|returned to you|back to your/,
    );
  });

  it('quotes the desk reason verbatim, because that is what the client acts on', () => {
    expect(render('The amount does not match the receipt').html).toContain(
      'The amount does not match the receipt',
    );
  });

  it('omits the reason line entirely rather than printing an empty one', () => {
    expect(render().html).not.toContain('Reason:');
  });

  /*
   * The layout signs every message off with "Please do not reply to it", and the
   * From address is a no-reply. An invitation to reply therefore sends a
   * client's receipt nowhere — at the moment they are most likely to act on it.
   * This shipped, was caught in a live mailbox, and is pinned here.
   */
  it('directs the client to support, never to replying', () => {
    const { html } = render();
    expect(html).toContain('contact support');
    expect(html).not.toContain('reply to this email');
  });

  it('does NOT tell an offline client that no funds were taken', () => {
    // True of a gateway failure, false here: the client may well have paid.
    expect(render().html).not.toContain('no funds were taken');
  });
});

describe('depositOutcome, the other two outcomes', () => {
  it('confirms a credit without hedging it', () => {
    const { subject, html } = depositOutcome(
      'John',
      'succeeded',
      '75.00000000',
      'USD',
      'https://portal.test',
    );
    expect(subject).toContain('Confirmed');
    expect(html).toContain('credited to your wallet');
  });

  it('still tells a GATEWAY failure that nothing was taken', () => {
    const { html } = depositOutcome('John', 'failed', '75.00000000', 'USD', 'https://portal.test');
    expect(html).toContain('no funds were taken');
  });

  it('formats money for a reader rather than printing the ledger string', () => {
    const { html } = depositOutcome(
      'John',
      'succeeded',
      '75.00000000',
      'USD',
      'https://portal.test',
    );
    expect(html).toContain('$75.00');
    expect(html).not.toContain('75.00000000');
  });
});
