import { Injectable } from '@nestjs/common';
import type { PaymentChannel, PaymentProviderAdapter } from './payment-provider';

/**
 * MANUAL — the desk, as a provider (0168).
 *
 * Built in and always on: it has no settings and nothing to connect to. Money
 * moves outside the platform and a person records it:
 *   deposit `offline`    — the client pays outside (OMT, a bank, cash) and the
 *                          desk confirms it; a method may require a receipt;
 *   deposit `adjustment` — the desk's own credit (`wallet.credit`), never a
 *                          method a client picks;
 *   payout  `desk`       — the desk pays to the destination the client gave;
 *   payout  `cash`       — the client collects in person.
 */
@Injectable()
export class ManualPaymentProvider implements PaymentProviderAdapter {
  readonly code = 'manual';
  readonly name = 'Manual';
  readonly builtIn = true;
  readonly configFields = [];

  readonly channels: readonly PaymentChannel[] = [
    {
      code: 'offline',
      direction: 'deposit',
      label: 'Paid outside the platform',
      flow: 'offline',
      settlementScale: null,
      currencies: 'any',
      bindable: true,
      acceptsReceipt: true,
    },
    {
      code: 'adjustment',
      direction: 'deposit',
      label: 'Desk adjustment',
      flow: 'adjustment',
      settlementScale: null,
      currencies: 'any',
      bindable: false,
    },
    {
      code: 'desk',
      direction: 'payout',
      label: 'Paid by the desk',
      flow: 'desk',
      settlementScale: null,
      currencies: 'any',
      bindable: true,
      destination: { kind: 'text', label: 'Where to send the money' },
    },
    {
      code: 'cash',
      direction: 'payout',
      label: 'Cash collected in person',
      flow: 'cash',
      settlementScale: null,
      currencies: 'any',
      bindable: true,
      destination: { kind: 'none', label: 'Collected in person' },
    },
  ];

  /** The desk is always there. */
  isUsable(): Promise<boolean> {
    return Promise.resolve(true);
  }
}
