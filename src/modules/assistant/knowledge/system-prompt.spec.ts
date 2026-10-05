import { describe, expect, it } from 'vitest';
import { languageOf } from './system-prompt';

/**
 * The answer's language is decided by the question's letters, not left to the
 * model: an Arabic question once came back in English (owner's report, 5 Oct 2026).
 */
describe('languageOf', () => {
  it('answers an Arabic question in Arabic, even with a Latin name inside', () => {
    expect(languageOf('كيف أسحب أموالي؟', 'en')).toBe('ar');
    expect(languageOf('كيف أسجّل الدخول إلى MT5؟', 'en')).toBe('ar');
  });

  it('answers an English question in English, whatever the portal shows', () => {
    expect(languageOf('How do I reset my MT5 password?', 'ar')).toBe('en');
  });

  it('falls back to the portal language when there are no letters', () => {
    expect(languageOf('1000 ?', 'ar')).toBe('ar');
  });
});
