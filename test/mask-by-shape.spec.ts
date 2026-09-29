import { describe, expect, it } from 'vitest';
import { ApiProperty } from '@nestjs/swagger';
import { ClientField, ClientFieldMap } from '../src/common/security/client-field.decorator';
import { maskByShape, maskByShapeReporting } from '../src/common/security/mask-by-shape';

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
  @ApiProperty() userId: number = 0;
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

describe('free-form maps, which a shape cannot describe', () => {
  /*
   * `KycSubmissionDto.personalInfo` is `Record<string, string>` because the KYC
   * step builder lets an operator ADD FIELDS — the shape genuinely is not
   * knowable at compile time. Walking declared properties therefore finds
   * nothing, while the catalogue masks four keys inside it.
   *
   * That made this the single largest hole in masking-by-shape, on the richest
   * concentration of client PII in the product. Keyed by catalogue PREFIX
   * instead, the reader's mask reaches keys whatever they are called —
   * including custom fields added after this code was written, which is the
   * property a fixed DTO could never have had.
   */
  class SubmissionDto {
    @ApiProperty() userId: number = 0;
    @ClientFieldMap('kyc.personalInfo') @ApiProperty() personalInfo: Record<string, string> = {};
  }

  const submission = () => ({
    userId: 'u1',
    personalInfo: {
      firstName: 'Alpha',
      dateOfBirth: '1990-01-01',
      nationality: 'Lebanon',
      favouriteColour: 'blue',
    },
  });

  it('removes a masked key from inside the map', () => {
    const masked = maskByShape(SubmissionDto, submission(), ['kyc.personalInfo.dateOfBirth']);

    expect('dateOfBirth' in masked.personalInfo).toBe(false);
    // Non-vacuous: the rest of the map survives, including the unmasked ones.
    expect(masked.personalInfo.nationality).toBe('Lebanon');
    expect(masked.personalInfo.firstName).toBe('Alpha');
    expect(masked.userId).toBe('u1');
  });

  it('removes a CUSTOM key the DTO could never have declared', () => {
    /*
     * The case that decides between this and a fixed DTO. An operator adds a
     * field in the KYC builder and masks it; nothing recompiles, and the
     * catalogue key is all either side needs to agree on.
     */
    const masked = maskByShape(SubmissionDto, submission(), ['kyc.personalInfo.favouriteColour']);
    expect('favouriteColour' in masked.personalInfo).toBe(false);
    expect(masked.personalInfo.dateOfBirth).toBe('1990-01-01');
  });

  it('leaves the map untouched when nothing in it is masked', () => {
    const body = submission();
    expect(maskByShape(SubmissionDto, body, ['client.email'])).toBe(body);
  });

  it('does not mutate the map it was given', () => {
    const body = submission();
    const original = body.personalInfo;
    maskByShape(SubmissionDto, body, ['kyc.personalInfo.dateOfBirth']);
    expect(original.dateOfBirth).toBe('1990-01-01');
  });
});

describe('shapes that are not errors', () => {
  /*
   * Ported from `field-mask.spec.ts` when the path-based mask was deleted.
   * Every case here is one that spec had pinned about `applyMask`, and each is
   * a way a response can legitimately be shaped — none of them is a bug, and a
   * mask that threw or mangled any of them would break a working screen.
   */
  class OwnerDto {
    @ApiProperty() id: string = '';
    @ClientField('client.email') @ApiProperty() email: string | null = '';
    @ClientField('client.phone') @ApiProperty() phone?: string;
  }
  class RowDto {
    @ApiProperty() id: string = '';
    @ApiProperty({ type: OwnerDto }) user: OwnerDto | null = new OwnerDto();
    @ApiProperty({ type: [OwnerDto] }) others: OwnerDto[] = [];
  }
  const HIDE = ['client.email'];

  it('removes a field whose value is NULL, rather than reading null as absent', () => {
    // "Has no address" and "may not see the address" must not converge: the
    // screen renders them differently, which is what `maskedFields` is for.
    const masked = maskByShape(RowDto, { id: 'r', user: { id: 'u', email: null } }, HIDE);
    expect('email' in (masked.user as object)).toBe(false);
  });

  it('is a no-op when a parent on the path is null or missing', () => {
    const nulled = { id: 'r', user: null };
    expect(maskByShape(RowDto, nulled, HIDE)).toBe(nulled);
    const absent = { id: 'r' };
    expect(maskByShape(RowDto, absent, HIDE)).toBe(absent);
  });

  it('passes non-objects straight through', () => {
    expect(maskByShape(RowDto, null, HIDE)).toBeNull();
    expect(maskByShape(RowDto, undefined, HIDE)).toBeUndefined();
    expect(maskByShape(RowDto, 'a string', HIDE)).toBe('a string');
  });

  it('copes with an empty list, and with elements that are not objects', () => {
    const empty = { id: 'r', others: [] };
    expect(maskByShape(RowDto, empty, HIDE)).toBe(empty);
    const odd = { id: 'r', others: [null, 'x'] };
    expect(maskByShape(RowDto, odd, HIDE)).toBe(odd);
  });

  it('clones only along the masked path, so a page is not deep-copied', () => {
    /*
     * A list response shares its rows with whatever else read them. Copying
     * every row to hide one field on one of them would make masking cost the
     * size of the page rather than the size of what it removes.
     */
    const untouched = { id: 'u2', email: 'b@x.test' };
    const row = { id: 'r', user: { id: 'u1', email: 'a@x.test' }, others: [untouched] };
    const masked = maskByShape(RowDto, row, ['client.phone']);
    expect(masked).toBe(row);
    expect(masked.others[0]).toBe(untouched);
  });
});

describe('reporting what was hidden (D-82)', () => {
  it('names each catalogue key it removed, once, and nothing the rows did not carry', () => {
    const page = {
      items: [
        {
          id: 'w1',
          balance: '1',
          user: { id: 'u1', email: 'a@x.test', firstName: 'A', lastName: 'B' },
        },
        {
          id: 'w2',
          balance: '2',
          user: { id: 'u2', email: 'c@x.test', firstName: 'C', lastName: 'D' },
        },
      ],
      total: 2,
    };
    const { value, removed } = maskByShapeReporting(PageDto, page, [
      'client.email',
      'client.phone', // hidden by the role, carried by no row: not reported
    ]);
    expect(removed).toEqual(['client.email']);
    expect(JSON.stringify(value)).not.toContain('@x.test');
  });

  it('reports nothing when nothing was hidden', () => {
    const row = { id: 'u', email: 'a@x.test', firstName: 'A', lastName: 'B' };
    expect(maskByShapeReporting(HoldingOwnerDto, row, []).removed).toEqual([]);
  });
});
