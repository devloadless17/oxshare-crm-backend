import { vi } from 'vitest';
import type { EmailService } from '../src/modules/email/email.service';

/**
 * A recording stand-in for the slice of `EmailService` the money suites touch,
 * beside `audit-stub.ts` / `commission-stub.ts` / `notifications-stub.ts` for
 * the same reason: those suites construct `TransactionsService` positionally.
 *
 * Whether a settled deposit actually renders and dispatches its mail is
 * `email-templates.spec.ts`'s question; here the mail only needs to be
 * callable and, occasionally, assertable.
 */
export function emailStub() {
  return {
    sendDepositOutcomeEmail: vi.fn().mockResolvedValue(undefined),
    sendWithdrawalDecisionEmail: vi.fn().mockResolvedValue(undefined),
    sendWalletCreditEmail: vi.fn().mockResolvedValue(undefined),
  };
}

/**
 * The stub, typed as the class the constructor asks for. `EmailService` has
 * private members, so this needs the double assertion — the same shape
 * `auditStubAs` records.
 */
export function emailStubAs(): EmailService {
  return emailStub() as unknown as EmailService;
}
