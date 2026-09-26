import { describe, expect, it } from 'vitest';
import {
  accountExists,
  adminInvite,
  adminPasswordReset,
  depositOutcome,
  kycDecision,
  partnerDecision,
  passwordReset,
  smtpTest,
  tradingAccountOpened,
  tradingAccountPasswordReset,
  verifyEmail,
  walletCredit,
  withdrawalDecision,
  setEmailLogoOrigin,
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
  [
    'depositOutcome succeeded',
    depositOutcome('Ann', 'succeeded', '250.00000000', 'USD', 'https://p.test'),
  ],
  [
    'depositOutcome failed',
    depositOutcome('Ann', 'failed', '250.00000000', 'USD', 'https://p.test'),
  ],
  [
    'withdrawalDecision approved',
    withdrawalDecision('Ann', 'approved', '100.00000000', 'USD', 'https://p.test'),
  ],
  [
    'withdrawalDecision paid',
    withdrawalDecision('Ann', 'paid', '100.00000000', 'USD', 'https://p.test'),
  ],
  [
    'withdrawalDecision rejected',
    withdrawalDecision('Ann', 'rejected', '100.00000000', 'USD', 'https://p.test', 'Wrong address'),
  ],
  ['adminInvite', adminInvite('Ann', 'https://a.test/i?t=T')],
  ['adminPasswordReset', adminPasswordReset('Ann', 'https://a.test/r', 'Boss', 30)],
  ['smtpTest', smtpTest('smtp.test', 587, 'database')],
] as const;

describe('every email shares one design', () => {
  for (const [name, m] of ALL) {
    it(`${name}: logo, card, footer, subject`, () => {
      // Our own opaque, light-surface logo, served by the portal — never the
      // broker's marketing-site file (a white wordmark that vanished on white).
      expect(m.html, 'logo').toContain('/brand/oxshare-email-logo.png');
      expect(m.html, 'logo host').not.toContain('wp-content');
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

  /**
   * ── ESCAPED ONCE. NOT TWICE. ───────────────────────────────────────────────
   *
   * `p()` escapes its own argument, so `p(esc(name))` escapes twice and the
   * second pass turns the first pass's output into literal text: a client called
   * `O'Brien` was greeted as `O&#39;Brien` in five money emails — wallet credit,
   * deposit outcome, withdrawal decision and both trading-account mails — until
   * 15 Sep 2026.
   *
   * It is worth a test rather than a comment because of how it reads in review.
   * `esc()` at a call site looks like the careful choice, and in the very same
   * files it IS: the values interpolated into raw `<strong>` markup need it. The
   * distinction is the HELPER, not the value — `p()` and `fine()` escape,
   * `pRich()` and `panel()` do not — and nothing about `p(esc(x))` looks wrong
   * enough to catch on a read.
   *
   * The assertion is on the entity, not on the apostrophe: `&#39;` in the output
   * is correct, `&amp;#39;` is the double-escape, and only the second renders as
   * visible punctuation in a mail client.
   */
  it.each([
    ['kycDecision', (n: string) => kycDecision(n, 'approved', 'https://p.test')],
    ['partnerDecision', (n: string) => partnerDecision(n, 'approved', 'https://p.test', {})],
    ['walletCredit', (n: string) => walletCredit(n, '10.00', 'USD', 'Bonus', 'https://p.test')],
    [
      'depositOutcome',
      (n: string) => depositOutcome(n, 'succeeded', '250.00', 'USD', 'https://p.test'),
    ],
    [
      'withdrawalDecision',
      (n: string) => withdrawalDecision(n, 'approved', '100.00', 'USD', 'https://p.test'),
    ],
    [
      'tradingAccountOpened',
      (n: string) =>
        tradingAccountOpened(n, '5001', 'live', 'USD', 100, 'a', 'b', 'https://p.test'),
    ],
    [
      'tradingAccountPasswordReset',
      (n: string) => tradingAccountPasswordReset(n, '5001', 'live', 'a', 'b', 'https://p.test'),
    ],
    ['adminInvite', (n: string) => adminInvite(n, 'https://a.test/i?t=T')],
    ['adminPasswordReset', (n: string) => adminPasswordReset(n, 'https://a.test/r', 'Boss', 30)],
  ])('%s escapes the name exactly ONCE', (_name, render) => {
    const html = render("O'Brien").html;
    // `&#39;` is a correctly escaped apostrophe. `&amp;#39;` is that entity
    // escaped a SECOND time, which a mail client renders as the literal text
    // `&#39;` — the client sees punctuation soup where their own name should be.
    expect(html).toContain('&#39;');
    expect(html).not.toContain('&amp;#39;');
  });

  it('escapes a name exactly once even when it contains markup', () => {
    const html = walletCredit('<b>Ann</b>', '10.00', 'USD', 'Bonus', 'https://p.test').html;
    expect(html).toContain('&lt;b&gt;Ann&lt;/b&gt;');
    expect(html).not.toContain('&amp;lt;');
  });
});

describe('the logo follows the environment that sends the mail', () => {
  it('is served by the portal EmailService is configured with', () => {
    setEmailLogoOrigin('https://oxshareportal.loadless.site');
    try {
      expect(adminInvite('Ann', 'https://a.test/i?t=T').html).toContain(
        'src="https://oxshareportal.loadless.site/brand/oxshare-email-logo.png"',
      );
    } finally {
      setEmailLogoOrigin('http://localhost:3000');
    }
  });
});
