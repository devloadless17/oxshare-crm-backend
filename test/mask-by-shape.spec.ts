import { describe, expect, it } from 'vitest';
import { ApiProperty } from '@nestjs/swagger';
import { ClientField } from '../src/common/security/client-field.decorator';
import { maskByShape } from '../src/common/security/mask-by-shape';

/**
 * THE SPIKE: can one annotation replace an alias list and six call sites?
 *
 * The question this answers is not "does a mask work" — `applyMask` works. It is
 * whether declaring the mask on the SHAPE removes the two opt-in steps that have
 * failed eight times: a per-surface alias entry, and a per-service call.
 *
 * The comparison is concrete rather than rhetorical. Closing the wallet and
 * trading-account exposure by hand took, for ONE field:
 *
 *   client-fields.json   wallet.user.email, tradingAccount.user.email,
 *                        walletExport.userEmail, tradingAccountExport.userEmail
 *   services             applyMask in listWallets, listTradingAccounts,
 *                        walletBatch, tradingAccountBatch
 *
 * Four aliases and four calls, for one field on one kind of person — and the
 * export half was missed on the first pass and shipped leaking, because the
 * route declares no response schema for the census to see.
 *
 * Below, the same coverage comes from marking `HoldingOwnerDto.email` once.
 */

// ── The shapes, as the real DTOs are written ────────────────────────────────

class HoldingOwnerDto {
  @ApiProperty() id: string = '';
  @ClientField('client.email') @ApiProperty() email: string = '';
  @ClientField('client.firstName') @ApiProperty() firstName: string = '';
  @ApiProperty() lastName: string = '';
}

class WalletRowDto {
  @ApiProperty() id: string = '';
  @ApiProperty() balance: string = '';
  @ApiProperty({ type: HoldingOwnerDto }) user: HoldingOwnerDto = new HoldingOwnerDto();
}

/** The SECOND desk, reusing the same person — the reuse is the whole point. */
class TradingAccountRowDto {
  @ApiProperty() id: string = '';
  @ApiProperty() login: string = '';
  @ApiProperty({ type: HoldingOwnerDto }) user: HoldingOwnerDto = new HoldingOwnerDto();
}

class PageDto {
  @ApiProperty({ type: [WalletRowDto] }) items: WalletRowDto[] = [];
  @ApiProperty() total: number = 0;
}

/** A recursive graph: a partner has a parent who is a partner. */
class PartnerDto {
  @ApiProperty() userId: string = '';
  @ClientField('client.email') @ApiProperty() email: string = '';
  @ApiProperty({ type: () => PartnerDto }) parent?: PartnerDto;
  @ApiProperty({ type: () => [PartnerDto] }) directPartners: PartnerDto[] = [];
}

const HIDE_EMAIL = ['client.email'];

describe('masking by shape', () => {
  it('hides the field on a nested person, and leaves the rest of the row', () => {
    const row = {
      id: 'w1',
      balance: '10.00000000',
      user: { id: 'u1', email: 'a@x.test', firstName: 'Alpha', lastName: 'Aardvark' },
    };
    const masked = maskByShape(WalletRowDto, row, HIDE_EMAIL);

    expect('email' in masked.user).toBe(false);
    // Non-vacuous: everything else survives. A mask that empties the row is a
    // broken screen, not a working control.
    expect(masked.user.firstName).toBe('Alpha');
    expect(masked.balance).toBe('10.00000000');
    expect(masked.user.id).toBe('u1');
  });

  it('covers a SECOND surface with no second declaration', () => {
    /*
     * The claim being tested. `TradingAccountRowDto` was never mentioned when
     * `HoldingOwnerDto.email` was marked, and no alias names it. Under the
     * current design this surface needed its own catalogue prefix and its own
     * applyMask call — and got neither until it was found leaking.
     */
    const row = { id: 'a1', login: '5001', user: { id: 'u1', email: 'a@x.test' } };
    const masked = maskByShape(TradingAccountRowDto, row, HIDE_EMAIL);

    expect('email' in masked.user).toBe(false);
    expect(masked.login).toBe('5001');
  });

  it('walks a page of rows, every element', () => {
    const page = {
      items: [
        { id: 'w1', balance: '1', user: { id: 'u1', email: 'a@x.test' } },
        { id: 'w2', balance: '2', user: { id: 'u2', email: 'b@x.test' } },
      ],
      total: 2,
    };
    const masked = maskByShape(PageDto, page, HIDE_EMAIL);

    expect(masked.items).toHaveLength(2);
    for (const item of masked.items) expect('email' in item.user).toBe(false);
    expect(masked.items.map((i) => i.id)).toEqual(['w1', 'w2']);
    expect(masked.total).toBe(2);
  });

  it('walks a recursive graph without recursing forever', () => {
    const detail = {
      userId: 'p1',
      email: 'p1@x.test',
      parent: { userId: 'p0', email: 'p0@x.test' },
      directPartners: [
        { userId: 'a', email: 'a@x.test' },
        { userId: 'b', email: 'b@x.test' },
      ],
    };
    const masked = maskByShape(PartnerDto, detail, HIDE_EMAIL);

    expect('email' in masked).toBe(false);
    expect('email' in (masked.parent as object)).toBe(false);
    for (const row of masked.directPartners) expect('email' in row).toBe(false);
    expect(masked.directPartners.map((r) => r.userId)).toEqual(['a', 'b']);
  });

  it('hides only what the mask names', () => {
    const row = { id: 'w1', balance: '1', user: { id: 'u1', email: 'a@x.test', firstName: 'A' } };
    const masked = maskByShape(WalletRowDto, row, ['client.firstName']);

    expect(masked.user.email, 'it masked a field the role never hid').toBe('a@x.test');
    expect('firstName' in masked.user).toBe(false);
  });

  it('does not mutate the row it was given', () => {
    // Rows are shared with audit writes and caches; masking in place would make
    // what got hidden depend on which consumer ran first.
    const user = { id: 'u1', email: 'a@x.test' };
    const row = { id: 'w1', balance: '1', user };
    maskByShape(WalletRowDto, row, HIDE_EMAIL);

    expect(user.email).toBe('a@x.test');
    expect(row.user).toBe(user);
  });

  it('treats an absent field as ordinary, and an empty mask as a no-op', () => {
    const row = { id: 'w1', balance: '1', user: { id: 'u1' } };
    expect(() => maskByShape(WalletRowDto, row, HIDE_EMAIL)).not.toThrow();

    const untouched = { id: 'w1', balance: '1', user: { id: 'u1', email: 'a@x.test' } };
    expect(maskByShape(WalletRowDto, untouched, [])).toBe(untouched);
  });

  it('masks NOTHING when the route declares no response shape', () => {
    /*
     * The honest failure mode, asserted so it is a known property rather than a
     * surprise. An undeclared response cannot be protected by this mechanism —
     * which is exactly why 42 of 170 admin routes needing a DTO is a
     * prerequisite of the migration and not a tidy-up after it.
     */
    const row = { user: { email: 'a@x.test' } };
    expect(maskByShape(undefined, row, HIDE_EMAIL)).toBe(row);
  });
});
