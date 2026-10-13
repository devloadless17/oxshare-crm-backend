import { describe, expect, it } from 'vitest';
import { SendBudget } from './send-budget';

describe('SendBudget', () => {
  it('caps how fast and how much one address is mailed, however it is spelled', () => {
    const budget = new SendBudget(5, 60_000);
    let now = 0;
    for (let sent = 0; sent < 5; sent += 1) {
      expect(budget.allows('Client@Example.test', now)).toBe(true);
      budget.record(' client@example.test ', now);
      expect(budget.allows('client@example.test', now + 59_000)).toBe(false); // the gap
      now += 61_000;
    }

    expect(budget.allows('client@example.test', now)).toBe(false); // the sixth in the hour
    expect(budget.allows('someone-else@example.test', now)).toBe(true);
    // An hour after the first send it has left the window, and one more may go.
    expect(budget.allows('client@example.test', 60 * 60_000 + 1)).toBe(true);
  });
});
