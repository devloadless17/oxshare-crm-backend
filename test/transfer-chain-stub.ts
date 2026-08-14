import { vi } from 'vitest';
import type { TransfersService } from '../src/modules/payments/transfers.service';
import type { TransferExecutor } from '../src/modules/payments/transfer-executor.service';

/**
 * Stand-ins for the two services that carry a deposit onward to a trading
 * account, for the unit suites that construct `TransactionsService` directly.
 *
 * The same reason `notifications-stub.ts` exists beside this: those files test
 * MONEY rules against real data and supply the collaborators themselves, rather
 * than booting Nest.
 *
 * ## They RECORD rather than refuse
 *
 * `chainTransferToAccount` catches its own failures on purpose — a settled
 * deposit must not be unwound because the onward leg failed — so a stub that
 * threw would be swallowed and the spec would pass either way. Recording means a
 * suite that wants to assert the chain happened can, and one that does not is
 * unaffected.
 *
 * Only the members that path calls are stubbed. A spec reaching for anything
 * else gets a TypeError naming the method, which is a better failure than a
 * silent undefined.
 */
export function transfersStubAs(): TransfersService {
  return {
    request: vi.fn().mockResolvedValue({ id: 'stub-transfer' }),
  } as unknown as TransfersService;
}

export function transferExecutorStubAs(): TransferExecutor {
  return {
    execute: vi.fn().mockResolvedValue({ id: 'stub-transfer', state: 'settled' }),
  } as unknown as TransferExecutor;
}
