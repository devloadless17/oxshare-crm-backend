import { Global, Module } from '@nestjs/common';
import { JobLeaseService } from './job-lease.service';

/**
 * Leader election for `@Cron` jobs, available everywhere.
 *
 * `@Global()` for the same reason `StoreModule` and `WalletModule` are: the
 * schedulers that need it live in five different feature modules — ib, trading,
 * payments, wallet, security — and importing a module into each of them, in both
 * directions where those modules already depend on one another, is how a cycle
 * gets built to share one stateless helper.
 */
@Global()
@Module({
  providers: [JobLeaseService],
  exports: [JobLeaseService],
})
export class SchedulingModule {}
