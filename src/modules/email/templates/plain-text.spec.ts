import { describe, expect, it } from 'vitest';
import { toPlainText } from './plain-text';
import { verifyEmail } from './verify-email';
import { walletCredit } from './wallet-credit';

const LINK = 'https://portal.oxshare.test/auth/verify-email?token=t0k3n&lang=en';

describe('the plain-text part every email carries', () => {
  it('keeps the code and the link, and no markup, in English and in Arabic', () => {
    for (const locale of ['en', 'ar'] as const) {
      const text = toPlainText(verifyEmail(LINK, '482913', locale).html);

      expect(text).toContain('482913');
      expect(text).toContain(LINK);
      expect(text).not.toMatch(/[<>]/);
      expect(text).not.toMatch(/&(amp|lt|gt|quot|#39);/);
      expect(text).not.toMatch(/\n{3,}/);
    }
  });

  it('reads escaped text back as typed, and isolates a left-to-right amount in Arabic', () => {
    const en = toPlainText(
      walletCredit("O'Brien & Co", '500', 'USD', 'Refund <fees>', 'https://p.test').html,
    );
    expect(en).toContain("Hello O'Brien & Co,");
    expect(en).toContain('Reason: Refund <fees>');

    const ar = toPlainText(walletCredit('سارة', '500', 'USD', 'r', 'https://p.test', 'ar').html);
    expect(ar).toMatch(/⁦[^⁩]*500[^⁩]*⁩/);
  });
});
