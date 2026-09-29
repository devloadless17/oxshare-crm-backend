/**
 * The route a fixture's legacy `provider` stands for — the SAME rule migration
 * 0168 backfilled every existing row with, so a fixture reads exactly like a
 * row written before providers existed:
 *   `whish`               → Rival's Whish (its deposit or its payout)
 *   any other withdrawal  → paid by the desk
 *   `manual_admin`        → the desk's own adjustment
 *   any other deposit     → paid outside the platform
 */
export function legacyRoute(provider: string, direction: 'deposit' | 'withdrawal') {
  const channelCode =
    provider === 'whish'
      ? 'whish'
      : direction === 'withdrawal'
        ? 'desk'
        : provider === 'manual_admin'
          ? 'adjustment'
          : 'offline';
  return {
    providerCode: provider === 'whish' ? 'rival' : 'manual',
    channelCode,
    providerEnvironment: 'live',
  };
}
