import { describe, expect, it } from 'vitest';
import { maskByShape } from '../src/common/security/mask-by-shape';
import { TradingAccountRowDto, WalletRowDto } from '../src/modules/admin/dto/responses.dto';
import {
  TradingAccountExportRowDto,
  WalletExportRowDto,
} from '../src/modules/admin/dto/export-rows.dto';
import { IbPartnerDetailDto } from '../src/modules/ib/dto/ib-application.dto';
import { CreatedMt5AccountDto } from '../src/modules/trading/mt5/dto/mt5-account.dto';
import { readFileSync } from 'node:fs';
import { maskedPathsFor } from '../src/common/security/field-mask';

/**
 * RBAC-03 on the WALLET and TRADING-ACCOUNT desks.
 *
 * Both screens join the client under `user` — the same shape the withdrawal
 * desk uses — and both served `user.email` to an administrator whose role was
 * configured to hide it. `applyMask` is opt-in, nothing on either path called
 * it, and the catalog carried no `wallet.` or `tradingAccount.` prefix, so even
 * adding the call would have masked nothing. Two halves, both missing, and no
 * test in the repo asserted about either.
 *
 * Found by `test/mask-coverage.spec.ts` on the day it was written, which is
 * exactly the argument for that census: the four surfaces that DID mask were
 * the four somebody had already thought about.
 *
 * Asserted at the seam that was actually broken — the expansion — rather than
 * over HTTP. The end-to-end version, an admin holding `wallets.view` with a
 * mask reading a real page, lives in `field-mask-enforcement.spec.ts` and is
 * driven from the route metadata so it cannot go missing.
 */

// Expand exactly as client-fields.service.ts does: key -> [key, ...aliases]
const catalog = JSON.parse(readFileSync('src/config/client-fields.json', 'utf8')) as Record<
  string,
  { fields?: { key?: string; aliases?: string[] }[] }
>;
function expand(keys: string[]): string[] {
  const map = new Map<string, string[]>();
  for (const [g, v] of Object.entries(catalog)) {
    if (g === '$comment' || typeof v !== 'object' || v === null) continue;
    for (const f of v.fields ?? []) if (f.key) map.set(f.key, [f.key, ...(f.aliases ?? [])]);
  }
  return keys.flatMap((k) => map.get(k) ?? [k]);
}

describe('masking client.email reaches the wallet and trading-account desks', () => {
  const mask = expand(['client.email']);

  it('expands to the wallet and tradingAccount aliases', () => {
    expect(mask).toContain('wallet.user.email');
    expect(mask).toContain('tradingAccount.user.email');
  });

  it('removes the address from a wallet row', () => {
    expect(maskedPathsFor('wallet', mask)).toContain('user.email');
    const row = { id: 'w1', user: { id: 'u1', email: 'alpha@x.test', firstName: 'Alpha' } };
    const masked = maskByShape(WalletRowDto, row, mask);
    expect('email' in masked.user).toBe(false);
    expect(masked.user.firstName, 'it removed more than it was asked to').toBe('Alpha');
  });

  it('removes the address from a trading-account row', () => {
    const row = { id: 'a1', user: { id: 'u1', email: 'alpha@x.test' } };
    const masked = maskByShape(TradingAccountRowDto, row, mask);
    expect('email' in masked.user).toBe(false);
  });
});

describe('the CSV half — the exports flatten the person, and must mask that too', () => {
  /*
   * The list was masked when this bypass was found; the EXPORT was not, and it
   * is the more damaging of the two: a file leaves the building carrying every
   * row in it.
   *
   * It survived the first pass because `GET /admin/wallets/export` declares no
   * response schema, so the openapi-driven census could not see it. 42 of 170
   * admin routes sit in that blind spot — which is why the census can promise
   * completeness over DECLARED schemas and not over routes.
   *
   * Separate prefixes, exactly as `withdrawal`/`withdrawalExport` are separate:
   * the desk nests the person under `user`, the CSV flattens them to
   * `userEmail`. One shared prefix would have the desk announce a flat key that
   * appears on none of the rows it returned.
   */
  const mask = expand(['client.email']);

  it('expands to the flattened export aliases', () => {
    expect(mask).toContain('walletExport.userEmail');
    expect(mask).toContain('tradingAccountExport.userEmail');
  });

  it('removes the address from an exported wallet row', () => {
    const row = { id: 'w1', userEmail: 'alpha@x.test', userFirstName: 'Alpha', balance: '0' };
    const masked = maskByShape(WalletExportRowDto, row, mask);
    expect('userEmail' in masked).toBe(false);
    expect(masked.userFirstName, 'it removed more than it was asked to').toBe('Alpha');
    expect(masked.balance, 'the money column is not a client field').toBe('0');
  });

  it('removes the address from an exported trading-account row', () => {
    const row = { id: 'a1', userEmail: 'alpha@x.test', login: '5001' };
    const masked = maskByShape(TradingAccountExportRowDto, row, mask);
    expect('userEmail' in masked).toBe(false);
    expect(masked.login).toBe('5001');
  });
});

describe('the partner detail — the parent AND every sub-partner', () => {
  /*
   * `GET /admin/ib/partners/:userId` returned the parent partner's email and
   * the identity of every direct sub-partner, unmasked — the same addresses
   * `/admin/clients/:id` correctly hides for the same reader, one screen away.
   * No service under `modules/ib` called applyMask at all.
   *
   * `directPartners` is an ARRAY, which is the half that has bitten this
   * feature before: `client.referredClients[].email` shipped a scoped admin's
   * whole downline until `removePath` learned to walk arrays (e808729). So the
   * array case is asserted on its own, not inferred from the parent's.
   *
   * The three portal-side projections in `ib-overview.service.ts` are
   * deliberately NOT masked and must stay that way: `overviewFor` and
   * `commissionsFor` are reached with `req.user.id` from the client portal, so
   * they are a partner reading their own network. An admin field mask has no
   * business there.
   */
  const mask = expand(['client.email']);

  it('expands to the partner-detail aliases, parent and downline', () => {
    expect(mask).toContain('ibPartner.parent.email');
    expect(mask).toContain('ibPartner.directPartners.email');
  });

  it("removes the parent's address while leaving the rest of the record", () => {
    const detail = {
      userId: 'p1',
      level: 1,
      parent: { userId: 'p0', email: 'parent@x.test', firstName: 'Pat', lastName: 'Rent' },
      directPartners: [],
    };
    const masked = maskByShape(IbPartnerDetailDto, detail, mask);
    expect('email' in masked.parent).toBe(false);
    expect(masked.parent.firstName, 'it removed more than it was asked to').toBe('Pat');
    expect(masked.level, 'the commission terms are not client fields').toBe(1);
  });

  it('removes the address from EVERY row of the sub-partner array', () => {
    const detail = {
      userId: 'p1',
      parent: null,
      directPartners: [
        { userId: 'a', email: 'a@x.test', firstName: 'A' },
        { userId: 'b', email: 'b@x.test', firstName: 'B' },
      ],
    };
    const masked = maskByShape(IbPartnerDetailDto, detail, mask);
    expect(masked.directPartners).toHaveLength(2);
    for (const row of masked.directPartners) expect('email' in row).toBe(false);
    // Non-vacuous: the rows are still there and still identifiable.
    expect(masked.directPartners.map((r) => r.userId)).toEqual(['a', 'b']);
  });
});

describe('opening an account hands back the address it just used', () => {
  /*
   * `POST /admin/trading-accounts` returns `credentialsSentTo`, which IS the
   * client's email. An operator whose role hides `client.email` was given it by
   * opening an account for that client.
   *
   * It survived every earlier sweep because the route declares no response
   * schema, so the openapi-driven census could not see the field to ask about
   * it — the same blind spot that hid the wallet CSV. 15 admin routes return
   * JSON with no declared shape; this was the one carrying a client field.
   *
   * The two portal twins (`createOwnAccount`, `resetOwnAccountPassword`) return
   * the same field and must stay unmasked: a client reading their own address.
   */
  const mask = expand(['client.email']);

  it('expands to the create-response alias', () => {
    expect(mask).toContain('tradingAccountCreated.credentialsSentTo');
  });

  it('hides the address while leaving the account usable on screen', () => {
    const response = {
      id: 'acc1',
      login: '5001',
      group: 'real\\Standard',
      credentialsSentTo: 'alpha@x.test',
    };
    const masked = maskByShape(CreatedMt5AccountDto, response, mask);

    expect('credentialsSentTo' in masked).toBe(false);
    // Non-vacuous: the operator still gets the account they just created.
    expect(masked.login).toBe('5001');
    expect(masked.id).toBe('acc1');
  });

  it('leaves the address alone for a reader who may see it', () => {
    const response = { id: 'acc1', login: '5001', credentialsSentTo: 'alpha@x.test' };
    expect(maskByShape(CreatedMt5AccountDto, response, []).credentialsSentTo).toBe('alpha@x.test');
  });
});
