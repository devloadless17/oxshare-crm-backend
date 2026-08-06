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
      expect(m.html, 'card bg').toContain('background: #0f172a');
      expect(m.html, 'footer').toContain('automated message from OxShare');
      expect(m.subject.length, 'subject').toBeGreaterThan(0);
    });
  }

  it('escapes a hostile display name', () => {
    const m = kycDecision('<script>x</script>', 'approved', 'https://p.test');
    expect(m.html).not.toContain('<script>');
    expect(m.html).toContain('&lt;script&gt;');
  });
});
