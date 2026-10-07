/**
 * EVERY background job whose timing is set in Settings → Scheduled jobs
 * (owner, 29 Sep 2026: "instead of having them within the .env file").
 *
 * Pure data: a key, where it runs, its default and the bounds an operator may
 * set it within. The console names and explains each by its key; the runner
 * (`ScheduledJobsRunner`) starts the CRM ones; the bridge reads `bridge.sweep`.
 *
 * A NEW JOB: add it here, put `@ScheduledJob('<key>')` on its method, and give
 * it a label in the admin's messages. Its row is created with the default on
 * first boot (and seeded by migration for the ones that existed in 0167).
 *
 * The bounds are the safe range, not a preference: below the minimum a job
 * would start again before the previous run could finish; above the maximum a
 * job the platform depends on (resuming stuck transfers, confirming commission)
 * would effectively stop.
 */
export const SCHEDULED_JOBS = [
  // ── MT5 ──────────────────────────────────────────────────────────────────
  /*
   * INSTANT, and not the admin's to see (owner, 7 Oct 2026). A closed trade, a
   * new account and an unknown group are now picked up the moment they happen
   * — the bridge's change feed and the webhooks behind it — so these two are
   * only the background SAFETY NET for anything an event missed: hidden from
   * Settings → Scheduled jobs, not editable, pinned to their default.
   *
   * `bridge.sweep` is GONE from this list: the bridge chooses its own safety
   * interval (long while its change feed works, short only if the broker's
   * server refuses the batch read). See `Mt5WebhooksController.bridgeSettings`.
   */
  {
    key: 'mt5.syncAccounts',
    group: 'mt5',
    runsOn: 'crm',
    defaultSeconds: 3600,
    min: 3600,
    max: 3600,
    hidden: true,
  },
  {
    key: 'mt5.syncGroups',
    group: 'mt5',
    runsOn: 'crm',
    defaultSeconds: 3600,
    min: 3600,
    max: 3600,
    hidden: true,
  },
  // ── Commission — ONE interval for both, kept in trading_settings (also the hold window) ──
  {
    key: 'ib.accrueDeals',
    group: 'commission',
    runsOn: 'crm',
    defaultSeconds: 3600,
    min: 60,
    max: 2_678_400,
    sharedInterval: 'commission',
  },
  {
    key: 'ib.confirmAccruals',
    group: 'commission',
    runsOn: 'crm',
    defaultSeconds: 3600,
    min: 60,
    max: 2_678_400,
    sharedInterval: 'commission',
  },
  // ── Money ────────────────────────────────────────────────────────────────
  {
    key: 'payments.resumeTransfers',
    group: 'money',
    runsOn: 'crm',
    defaultSeconds: 60,
    min: 30,
    max: 3600,
  },
  {
    // Every payment provider's poll behind its webhook (0173; `rival.reconcile` before).
    key: 'payments.reconcileProviders',
    group: 'money',
    runsOn: 'crm',
    defaultSeconds: 300,
    min: 60,
    max: 3600,
  },
  {
    key: 'payments.foldMovementTotals',
    group: 'money',
    runsOn: 'crm',
    defaultSeconds: 60,
    min: 30,
    max: 3600,
  },
  {
    // What each payment provider was asked and answered, kept 90 days (0175).
    key: 'payments.pruneExchanges',
    group: 'money',
    runsOn: 'crm',
    defaultSeconds: 86_400,
    min: 3600,
    max: 604_800,
  },
  {
    key: 'wallet.reconcile',
    group: 'money',
    runsOn: 'crm',
    defaultSeconds: 3600,
    min: 600,
    max: 86_400,
  },
  // ── System ───────────────────────────────────────────────────────────────
  {
    key: 'security.sweep',
    group: 'system',
    runsOn: 'crm',
    defaultSeconds: 3600,
    min: 300,
    max: 86_400,
  },
  {
    key: 'notifications.prune',
    group: 'system',
    runsOn: 'crm',
    defaultSeconds: 86_400,
    min: 3600,
    max: 604_800,
  },
  {
    key: 'assistant.prune',
    group: 'system',
    runsOn: 'crm',
    defaultSeconds: 86_400,
    min: 3600,
    max: 604_800,
  },
] as const satisfies readonly ScheduledJobDefinition[];

export interface ScheduledJobDefinition {
  key: string;
  group: 'mt5' | 'commission' | 'money' | 'system';
  /** `bridge`: the MT5 bridge runs it and reads its interval from the CRM. */
  runsOn: 'crm' | 'bridge';
  defaultSeconds: number;
  min: number;
  max: number;
  /** Its interval is a setting shared with another (the commission pair). */
  sharedInterval?: 'commission';
  /**
   * A background safety net the admin never sees (7 Oct 2026): left out of
   * Settings → Scheduled jobs, refused by its edit and run-now routes, and
   * always run at `defaultSeconds` whatever an older row stored.
   */
  hidden?: true;
}

export type ScheduledJobKey = (typeof SCHEDULED_JOBS)[number]['key'];

export function scheduledJob(key: string): ScheduledJobDefinition | undefined {
  return (SCHEDULED_JOBS as readonly ScheduledJobDefinition[]).find((job) => job.key === key);
}
