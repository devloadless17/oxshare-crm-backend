import { describe, expect, it } from 'vitest';
import { withoutCitations } from './answer-text';

describe('an answer is stored without web-search residue', () => {
  it('drops inline citations and raw citation markers, and nothing else', () => {
    expect(
      withoutCitations(
        'Gold is near **4,160** ([kitco.com](https://www.kitco.com/x?utm_source=openai)). ' +
          'Verification is needed.citeturn0search0',
      ),
    ).toBe('Gold is near **4,160**. Verification is needed.');
    const kept = 'Open [Deposit](/deposit). Read [the report](https://example.com/r) (in full).';
    expect(withoutCitations(kept)).toBe(kept);
  });
});
