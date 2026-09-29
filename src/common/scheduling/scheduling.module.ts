import { Global, Module } from '@nestjs/common';
import { DiscoveryModule } from '@nestjs/core';
import { ScheduledJobsRunner } from './scheduled-jobs.runner';
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
  // DiscoveryModule: the runner finds every @ScheduledJob method (settings-driven timing, 0167).
  imports: [DiscoveryModule],
  providers: [JobLeaseService, ScheduledJobsRunner],
  exports: [JobLeaseService],
})
export class SchedulingModule {}
