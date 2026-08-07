import { describe, expect, it } from 'vitest';
import {
  accountExists,
  adminInvite,
  adminPasswordReset,
  kycDecision,
  partnerDecision,
  passwordReset,
  smtpTest,
  verifyEmail,
} from '../src/modules/email/templates';

const ALL = [
  ['verifyEmail', verifyEmail('https://p.test/v?token=T')],
  ['passwordReset', passwordReset('https://p.test/r?token=T')],
  ['accountExists', accountExists('https://p.test/auth/login')],
  ['kycDecision approved', kycDecision('Ann', 'approved', 'https://p.test')],
  ['kycDecision rejected', kycDecision('Ann', 'rejected', 'https://p.test', 'Blurry')],
  [
    'partnerDecision approved',
    partnerDecision('Ann', 'approved', 'https://p.test', { referralCode: 'OX-1' }),
  ],
  [
    'partnerDecision rejected',
    partnerDecision('Ann', 'rejected', 'https://p.test', { reason: 'No' }),
  ],
  ['adminInvite', adminInvite('Ann', 'https://a.test/i?t=T')],
  ['adminPasswordReset', adminPasswordReset('Ann', 'https://a.test/r', 'Boss', 30)],
  ['smtpTest', smtpTest('smtp.test', 587, 'database')],
] as const;

describe('every email shares one design', () => {
  for (const [name, m] of ALL) {
    it(`${name}: logo, card, footer, subject`, () => {
      expect(m.html, 'logo').toContain('main-logo1920.png');
      expect(m.html, 'alt text').toContain('alt="OxShare"');
      expect(m.html, 'card').toContain('max-width: 600px');
      expect(m.html, 'footer').toContain('automated message from OxShare');
      expect(m.subject.length, 'subject').toBeGreaterThan(0);
    });

    /*
     * The card used to force `background: #0f172a` with near-white text, so a
     * light-themed phone showed a dark slab in a white inbox and nothing like
     * the product the mail came from. It now sets neither, and the reader's
     * client supplies both.
     *
     * Asserted PER TEMPLATE, because the failure this guards against is a
     * partial revert: one template keeping a near-white text colour that was
     * only readable on the old dark card renders as invisible text.
     * `withdrawal-otp` had exactly that — a `#f8fafc` confirmation code.
     */
    it(`${name}: forces neither a background nor near-white text`, () => {
      expect(m.html, 'no dark card').not.toContain('#0f172a');
      expect(m.html, 'no near-white text').not.toMatch(/#f8fafc/i);
    });

    /*
     * The accent is the PRODUCT's, not a generic blue. These were #3b82f6 and
     * #2563eb, which appear nowhere in the portal or the admin console, so a
     * verification mail did not look like the site that sent it.
     */
    it(`${name}: uses the OxShare amber, never the old blue`, () => {
      expect(m.html, 'no generic blue').not.toMatch(/#3b82f6|#2563eb/i);
    });
  }

  it('escapes a hostile display name', () => {
    const m = kycDecision('<script>x</script>', 'approved', 'https://p.test');
    expect(m.html).not.toContain('<script>');
    expect(m.html).toContain('&lt;script&gt;');
  });
});
