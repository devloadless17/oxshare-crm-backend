import { describe, expect, it } from 'vitest';
import { join } from 'node:path';
import { SERVER_MESSAGES_AR } from '../src/common/i18n/server-messages.ar';
import { localizeMessage } from '../src/common/i18n/localize-message';
import { scanServerMessages } from './server-message-scan';

/**
 * Every English sentence a portal client can be sent has its Arabic (2 Oct 2026).
 *
 * The rule inverted, as the audit and scope coverage specs invert theirs: the
 * source is SCANNED for every message thrown (`server-message-scan.ts` says what
 * counts), and each must have an entry in `common/i18n/server-messages.ar.ts` —
 * exactly, or as the `{n}` pattern its template literal becomes. A new English
 * sentence without Arabic fails here, in the same change that wrote it.
 *
 * The admin console is English only, but its refusals are scanned and
 * translated too: telling an admin-only sentence from a client-reachable one
 * file by file is a judgement that silently rots, and a translation nobody
 * reads costs nothing.
 */

const ROOT = join(__dirname, '..');

/** Everything a portal client's request can reach. */
const DIRS = [
  'src/modules/identity',
  'src/modules/compliance',
  'src/modules/profile',
  'src/modules/wallet',
  'src/modules/payments',
  'src/modules/trading',
  'src/modules/ib',
  'src/modules/notifications',
  'src/modules/client-identity',
  'src/modules/currencies',
  'src/modules/external-links',
  'src/modules/platforms',
  'src/modules/products',
  'src/modules/leverages',
  'src/common',
  'src/store',
];

/**
 * Messages passed through a VARIABLE, so the scan cannot read them — each one
 * checked by hand: its sentences come from a file the scan reads as a sentence
 * file (`SENTENCE_FILES`), or it is somebody else's text (a provider's own
 * error, class-validator's defaults, which have patterns of their own here).
 * A new entry means a new dynamic source: make sure its sentences are covered,
 * then add it.
 */
const KNOWN_DYNAMIC = new Set([
  'src/modules/identity/auth.service.ts profileError', // client-profile.ts
  'src/modules/identity/auth.service.ts errors',
  'src/modules/identity/auth.service.ts lockoutMessage(lockedFor)', // lockout-message.ts
  'src/modules/compliance/kyc-client.service.ts message', // refusalFor, sentence file
  'src/modules/compliance/kyc-client.service.ts fields',
  'src/modules/compliance/kyc-client.service.ts problems[0].message', // kyc-answers.ts
  'src/modules/compliance/kyc-client.service.ts Object.fromEntries(problems.map((problem) => [problem.field, problem.message]))',
  'src/modules/compliance/uploads.controller.ts policy.adminForbidden', // sentence file
  'src/modules/compliance/uploads.controller.ts policy.clientForbidden',
  'src/modules/compliance/uploads.controller.ts policy.notFound',
  'src/modules/profile/client-profile.service.ts message', // client-profile.ts
  'src/modules/profile/client-profile.service.ts check.errors',
  'src/modules/profile/client-profile.service.ts refusal',
  'src/modules/profile/client-profile.service.ts refused',
  'src/modules/profile/client-profile.service.ts first',
  'src/modules/profile/client-profile.service.ts held',
  'src/modules/payments/payment-methods.service.ts Object.values(fields)[0]', // admin form
  'src/modules/payments/payment-methods.service.ts fields',
  'src/modules/payments/payment-methods.service.ts COUNTRY_REFUSAL', // method-eligibility.ts
  'src/modules/payments/withdrawal-commands.ts COUNTRY_REFUSAL',
  'src/modules/payments/withdrawal-commands.ts destinationIssue', // wish-phone, threepay-address
  'src/modules/payments/providers/payment-providers.service.ts `${adapter.name} · ${field.label}: ${problem}`', // admin
  'src/modules/payments/providers/payment-providers.service.ts problem',
  'src/modules/payments/providers/rival/rival.client.ts message', // Rival's own words
  'src/modules/trading/mt5/mt5-bridge.client.ts message', // assertBridgeConfigured: callers pass catalogued sentences
  'src/modules/payments/providers/threepay/threepay.provider.ts explain(error)', // admin test
  'src/modules/currencies/currencies.service.ts Object.values(problems)[0]', // currency-limits.ts
  'src/modules/currencies/currencies.service.ts problems',
  'src/common/payments/proof-fields.ts first', // sentence file
  'src/common/payments/proof-fields.ts errors',
  'src/common/uploads/stored-files.service.ts bucket.rejectionMessage', // sentence file
  'src/common/uploads/stored-files.service.ts ACTIVE_CONTENT_REJECTION', // active-content.ts
  'src/common/validation.config.ts flattenMessages(errors)', // class-validator patterns
  'src/common/validation.config.ts toFieldMap(errors)',
]);

/** Framework sentences no scan of our source finds, and the commonest class-validator ones. */
const FRAMEWORK = [
  'Unauthorized',
  'Forbidden resource',
  'File too large',
  'Unexpected field',
  'File is required',
  'Validation failed (uuid is expected)',
  'Validation failed (numeric string is expected)',
  'Cannot GET /v1/nothing-here',
  'amount must be a number string',
  'name must be a string',
  'email must be an email',
  'email should not be empty',
  'environment must be one of the following values: live, demo',
  'name must be shorter than or equal to 128 characters',
  'code must be longer than or equal to 6 characters',
  'leverage must not be less than 1',
  'property foo should not exist',
  'each value in ids must be a UUID',
];

const scan = scanServerMessages(ROOT, DIRS);

describe('every server message has Arabic', () => {
  it('finds the messages at all (the scan is not silently empty)', () => {
    expect(scan.messages.length).toBeGreaterThan(400);
  });

  it('has a catalogue entry for every message the source throws', () => {
    const missing = new Set<string>();
    for (const message of scan.messages) {
      if (Object.prototype.hasOwnProperty.call(SERVER_MESSAGES_AR, message.key)) continue;
      // An exact sentence may be covered by a pattern or a label twin instead.
      if (!message.pattern && localizeMessage(message.key, 'ar') !== message.key) continue;
      missing.add(`${message.file}:${message.line}  ${JSON.stringify(message.key)}`);
    }
    expect([...missing]).toEqual([]);
  });

  it('knows every message passed through a variable', () => {
    const unknown = scan.unresolved
      .map((u) => `${u.file} ${u.expression.replace(/\s+/g, ' ')}`)
      .filter((entry) => !KNOWN_DYNAMIC.has(entry));
    expect([...new Set(unknown)]).toEqual([]);
  });

  it.each(FRAMEWORK)('translates the framework sentence %j', (english) => {
    expect(localizeMessage(english, 'ar')).not.toBe(english);
  });
});

describe('the catalogue itself', () => {
  const entries = Object.entries(SERVER_MESSAGES_AR);

  it.each(entries)('%j uses only placeholders its English has', (english, arabic) => {
    const numbers = (text: string) => new Set([...text.matchAll(/\{(\d+)\}/g)].map((m) => m[1]));
    const en = numbers(english);
    for (const n of numbers(arabic)) expect(en.has(n)).toBe(true);
    expect(arabic.trim()).not.toBe('');
    // Arabic text, not an English key copied across.
    expect(arabic).toMatch(/[؀-ۿ]/);
  });
});
