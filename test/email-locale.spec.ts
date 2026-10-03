import { describe, expect, it, vi } from 'vitest';
import { EmailService } from '../src/modules/email/email.service';
import type { RenderedEmail } from '../src/modules/email/templates';

/**
 * The operator's REASON inside an Arabic email.
 *
 * A reason is the desk's text. When it is a catalogue label (`rejection_reasons`)
 * of the same context that carries an Arabic twin, an Arabic mail shows the
 * twin — also when a reviewer's note was appended ("label — note"). Anything
 * else is mailed as typed, and an English mail is never touched.
 */

const CATALOGUE = {
  kyc: [
    { label: 'Document is blurry', labelAr: 'المستند غير واضح' },
    { label: 'Untranslated reason', labelAr: null },
  ],
  partner: [{ label: 'Application is incomplete', labelAr: 'الطلب غير مكتمل' }],
  withdrawal: [{ label: 'Document is blurry', labelAr: 'سياق آخر' }],
  deposit: [],
} as const;

function build() {
  const config = {
    get: (key: string, fallback?: unknown) => (key === 'NODE_ENV' ? 'test' : fallback),
  };
  const lookups: string[][] = [];
  const store = {
    // The store's resolver, over this fixture catalogue.
    arabicFor: vi.fn((contexts: (keyof typeof CATALOGUE)[]) => {
      lookups.push(contexts);
      return Promise.resolve((context: keyof typeof CATALOGUE, text?: string | null) => {
        const row = (
          CATALOGUE[context] as readonly { label: string; labelAr: string | null }[]
        ).find((r) => r.label === text);
        return row?.labelAr ?? undefined;
      });
    }),
  };
  const service = new EmailService(config as never, {} as never, store as never);
  const sent: RenderedEmail[] = [];
  vi.spyOn(service as unknown as { send: () => Promise<void> }, 'send').mockImplementation(
    (...args: unknown[]) => {
      sent.push(args[2] as RenderedEmail);
      return Promise.resolve();
    },
  );
  return { service, store, sent };
}

describe('an operator reason in an Arabic email', () => {
  it('uses the catalogue Arabic for an exact label of the same context', async () => {
    const { service, sent } = build();
    await service.sendKycDecisionEmail('a@x.test', 'A', 'rejected', 'Document is blurry', [], 'ar');
    expect(sent[0].html).toContain('المستند غير واضح');
    expect(sent[0].html).not.toContain('Document is blurry');
    expect(sent[0].html).toContain('<html lang="ar" dir="rtl">');
  });

  it('translates the label and keeps the reviewer note of a composed reason', async () => {
    const { service, sent } = build();
    await service.sendPartnerDecisionEmail(
      'a@x.test',
      'A',
      'rejected',
      { reason: 'Application is incomplete — No website given.' },
      'ar',
    );
    expect(sent[0].html).toContain('الطلب غير مكتمل — No website given.');
  });

  it('mails free text, and a label with no Arabic, exactly as typed', async () => {
    const { service, sent } = build();
    await service.sendKycDecisionEmail('a@x.test', 'A', 'rejected', 'Something else', [], 'ar');
    await service.sendKycDecisionEmail(
      'a@x.test',
      'A',
      'rejected',
      'Untranslated reason',
      [],
      'ar',
    );
    expect(sent[0].html).toContain('Something else');
    expect(sent[1].html).toContain('Untranslated reason');
  });

  it("never borrows another context's Arabic", async () => {
    const { service, sent } = build();
    await service.sendDepositOutcomeEmail(
      'a@x.test',
      'A',
      'rejected',
      '1',
      'USD',
      'Document is blurry',
      'ar',
    );
    expect(sent[0].html).toContain('Document is blurry');
  });

  it('does not look anything up for an English email', async () => {
    const { service, store, sent } = build();
    await service.sendWithdrawalDecisionEmail(
      'a@x.test',
      'A',
      'rejected',
      '1',
      'USD',
      'Document is blurry',
    );
    expect(store.arabicFor).not.toHaveBeenCalled();
    expect(sent[0].html).toContain('Document is blurry');
    expect(sent[0].html).not.toContain('dir="rtl"');
  });

  it('falls back to the typed reason when the lookup fails', async () => {
    const { service, store, sent } = build();
    store.arabicFor.mockRejectedValueOnce(new Error('db down'));
    await service.sendKycReverificationEmail('a@x.test', 'A', 'Document is blurry', [], 'ar');
    expect(sent[0].html).toContain('Document is blurry');
  });
});
