import type { EmailService } from '../src/modules/email/email.service';

/**
 * A recording stand-in for the WHOLE of `EmailService`, for the journey suites.
 *
 * `email-stub.ts` is the narrow version: three named methods, for the money
 * suites that construct `TransactionsService` positionally. A journey walks
 * routes that send mail nobody predicted — a KYC decision, a trading account
 * opening, a wallet credit — and a stub missing one of those fails the journey
 * with a TypeError about a method rather than a message about the step.
 *
 * So this answers every property with a recording function. Two things follow
 * from that and both are deliberate:
 *
 *  - Nothing is asserted about RENDERING. `email-templates.spec.ts` owns that.
 *    What a journey needs to know is that the client was told, and with what —
 *    the verification TOKEN is only obtainable this way, because the column
 *    stores a hash.
 *  - An unexpected send is recorded rather than refused, so adding a mail to a
 *    route does not break a journey that has nothing to say about it.
 */
export interface RecordedMail {
  method: string;
  args: unknown[];
}

export function emailRecorder() {
  const calls: RecordedMail[] = [];

  const service = new Proxy(
    {},
    {
      get(_target, property) {
        // Nest and the test runner both probe for `then` to decide whether a
        // value is a promise; answering with a function makes this thenable and
        // any `await` of it hangs.
        if (typeof property !== 'string' || property === 'then') return undefined;
        return (...args: unknown[]) => {
          calls.push({ method: property, args });
          return Promise.resolve();
        };
      },
    },
  ) as EmailService;

  return {
    service,
    calls,
    /** The first send of `method` addressed to `to` — mail is always arg 0. */
    find(method: string, to: string): RecordedMail | undefined {
      return calls.find((c) => c.method === method && c.args[0] === to);
    },
    /**
     * The LAST send of `method` to `to` — the one whose link and code are live.
     * A resend, or a sign-in to an unconfirmed account, supersedes the first.
     */
    latest(method: string, to: string): RecordedMail | undefined {
      return [...calls].reverse().find((c) => c.method === method && c.args[0] === to);
    },
    sentTo(to: string): string[] {
      return calls.filter((c) => c.args[0] === to).map((c) => c.method);
    },
    /**
     * Wait for a send, because several are FIRE-AND-FORGET.
     *
     * A decision email must never fail the decision it describes, so the
     * services `void` the call: the mail leaves some time after the HTTP
     * response the caller already holds. Asserting on the next line races it,
     * and usually wins — which is the worst kind of flake, passing locally and
     * failing on a loaded CI box. Polling returns as soon as the mail is there,
     * so the ordinary case costs nothing and a genuine non-sender still fails.
     */
    async waitFor(method: string, to: string, timeoutMs = 3000): Promise<RecordedMail | undefined> {
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        const found = calls.find((c) => c.method === method && c.args[0] === to);
        if (found || Date.now() >= deadline) return found;
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
    },
  };
}
