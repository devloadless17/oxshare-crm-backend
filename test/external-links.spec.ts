import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import {
  assertSafeExternalUrl,
  ExternalLinksService,
} from '../src/modules/external-links/external-links.service';
import { auditStubAs, TEST_ACTOR as ACTOR } from './audit-stub';
import { startMoneyTestDb, stopMoneyTestDb, type MoneyTestContext } from './money-setup';

/**
 * The portal sidebar's links.
 *
 * Against a real database rather than a stub, for the reason `leverages.spec.ts`
 * gives: the rules that matter here are statements about the OTHER ROWS.
 * "Placing this link at position 1 moves the one already there" and "deleting
 * the middle of five closes the gap" cannot be exercised by a service holding a
 * fake that returns whatever the test says.
 *
 * The URL check is the exception and is unit-tested directly — it is a pure
 * function over a string, and it is the one thing here standing between an admin
 * account and stored XSS on every client's chrome.
 */
let ctx: MoneyTestContext;
let service: ExternalLinksService;

beforeAll(async () => {
  ctx = await startMoneyTestDb();
  service = new ExternalLinksService(ctx.db, auditStubAs());
}, 120_000);

afterAll(async () => {
  await stopMoneyTestDb(ctx);
});

beforeEach(async () => {
  await ctx.db.execute(sql`DELETE FROM external_links`);
});

/** Seed three links in a known order, and hand back their ids in that order. */
async function seedThree(): Promise<string[]> {
  const first = await service.create({ title: 'Calendar', url: 'https://example.com/cal' }, ACTOR);
  const second = await service.create({ title: 'Help', url: 'https://example.com/help' }, ACTOR);
  const third = await service.create({ title: 'Blog', url: 'https://example.com/blog' }, ACTOR);
  return [first.id, second.id, third.id];
}

describe('what a client is shown', () => {
  it('lists the enabled links in the operator’s order', async () => {
    await seedThree();

    // The order is the operator's, not the alphabet's — `Blog` was added last
    // and stays last.
    expect((await service.listEnabled()).map((row) => row.title)).toEqual([
      'Calendar',
      'Help',
      'Blog',
    ]);
  });

  it('leaves a hidden link out entirely rather than flagging it', async () => {
    const [, helpId] = await seedThree();
    await service.update(helpId, { enabled: false }, ACTOR);

    // Filtering in the service is what stops a caller forgetting to — the portal
    // renders what it receives straight through.
    expect((await service.listEnabled()).map((row) => row.title)).toEqual(['Calendar', 'Blog']);
  });

  it('never tells the client which links are switched off', async () => {
    await seedThree();

    /*
     * The client shape is a strict subset. `enabled` could only ever say `true`
     * here, and `updatedBy` is the id of an administrator — neither belongs in a
     * response every customer receives.
     */
    const [row] = await service.listEnabled();
    expect(Object.keys(row).sort()).toEqual(['description', 'id', 'sortOrder', 'title', 'url']);
  });

  it('answers with an empty list rather than anything else when none are configured', async () => {
    /*
     * An ordinary answer, not a state to fall back from — unlike the leverage
     * ladder, which seeds defaults because an empty one leaves a client an
     * account-opening form with no options. No links is a sidebar with no extra
     * section, which is a complete screen.
     */
    expect(await service.listEnabled()).toEqual([]);
  });

  it('shows an operator the hidden links too', async () => {
    const [, helpId] = await seedThree();
    await service.update(helpId, { enabled: false }, ACTOR);

    // The admin list is NOT the client list: somebody has to see what they took
    // down in order to put it back.
    expect((await service.listAll()).map((row) => row.title)).toEqual(['Calendar', 'Help', 'Blog']);
  });
});

describe('adding a link', () => {
  it('appends when no position is asked for', async () => {
    await seedThree();

    // `0, 1, 2` with no gaps — the number in the form is the position on the
    // screen, not a spacing convention.
    expect((await service.listAll()).map((row) => row.sortOrder)).toEqual([0, 1, 2]);
  });

  it('inserts at the position asked for and pushes the rest down', async () => {
    await seedThree();
    await service.create(
      { title: 'Analysis', url: 'https://example.com/analysis', sortOrder: 1 },
      ACTOR,
    );

    /*
     * The defect `placeInOrder` exists for: typing a position another row holds
     * used to produce a DUPLICATE, and the list then fell back to its tiebreak —
     * so the row appeared somewhere the operator did not put it, with no error.
     */
    expect((await service.listAll()).map((row) => row.title)).toEqual([
      'Calendar',
      'Analysis',
      'Help',
      'Blog',
    ]);
  });

  it('stores a blank description as null rather than an empty string', async () => {
    const created = await service.create(
      { title: 'Calendar', url: 'https://example.com/cal', description: '   ' },
      ACTOR,
    );

    // Null is the real answer — "Economic calendar" needs no gloss — and one
    // representation of "no description" is what stops the portal checking two.
    expect(created.description).toBeNull();
  });

  it('refuses a title that is only whitespace', async () => {
    await expect(
      service.create({ title: '   ', url: 'https://example.com' }, ACTOR),
    ).rejects.toThrow(/needs a title/i);
  });
});

describe('editing a link', () => {
  it('changes only what was sent', async () => {
    const [calendarId] = await seedThree();

    const updated = await service.update(calendarId, { title: 'Economic calendar' }, ACTOR);

    expect(updated.title).toBe('Economic calendar');
    // The URL is untouched — a PATCH that quietly blanked the fields it was not
    // given would make renaming a link a way to break it.
    expect(updated.url).toBe('https://example.com/cal');
    expect(updated.enabled).toBe(true);
  });

  it('clears the description when an empty string is sent', async () => {
    const created = await service.create(
      { title: 'Calendar', url: 'https://example.com/cal', description: 'Every release, live' },
      ACTOR,
    );

    // The alternative is a separate "remove the subtitle" control, which is how
    // a stale line of copy stays on screen.
    const updated = await service.update(created.id, { description: '' }, ACTOR);
    expect(updated.description).toBeNull();
  });

  it('moves a link up and moves the displaced ones down', async () => {
    const [, , blogId] = await seedThree();

    await service.update(blogId, { sortOrder: 0 }, ACTOR);

    expect((await service.listAll()).map((row) => row.title)).toEqual(['Blog', 'Calendar', 'Help']);
  });

  it('clamps a position past the end rather than refusing it', async () => {
    const [calendarId] = await seedThree();

    // An operator typing 999 into a list of three means "put it last", and
    // refusing that is a validation error about an intention that was clear.
    await service.update(calendarId, { sortOrder: 999 }, ACTOR);

    expect((await service.listAll()).map((row) => row.title)).toEqual(['Help', 'Blog', 'Calendar']);
  });

  it('refuses an unknown id', async () => {
    await expect(
      service.update('00000000-0000-4000-8000-0000000000ff', { title: 'x' }, ACTOR),
    ).rejects.toThrow(/no such link/i);
  });
});

describe('deleting a link', () => {
  it('closes the gap it leaves in the ordering', async () => {
    const [, helpId] = await seedThree();

    await service.remove(helpId, ACTOR);

    /*
     * Removing position 1 of three leaves `0, 2` — a gap that is invisible until
     * somebody types 1 into the form and lands on top of a row instead of before
     * it.
     */
    const remaining = await service.listAll();
    expect(remaining.map((row) => row.title)).toEqual(['Calendar', 'Blog']);
    expect(remaining.map((row) => row.sortOrder)).toEqual([0, 1]);
  });

  it('refuses an unknown id', async () => {
    await expect(service.remove('00000000-0000-4000-8000-0000000000ff', ACTOR)).rejects.toThrow(
      /no such link/i,
    );
  });
});

describe('the URL a client is handed', () => {
  /*
   * The one thing standing between an admin account — or whatever compromises
   * one — and stored XSS against every client who signs in. `javascript:` in an
   * anchor executes on click, in the client's session, on the portal's origin.
   */
  it.each([
    'javascript:alert(1)',
    'data:text/html,<script>alert(1)</script>',
    'file:///etc/passwd',
  ])('refuses %s', (raw) => {
    expect(() => assertSafeExternalUrl(raw)).toThrow(/http or https/i);
  });

  it('refuses a bare host with no scheme', () => {
    // Not a guess about what the operator meant: prefixing `https://` for them
    // is how a link to the wrong place gets saved silently.
    expect(() => assertSafeExternalUrl('example.com/calendar')).toThrow(/complete URL/i);
  });

  it('accepts http as well as https, and returns the trimmed value', () => {
    /*
     * Unlike a platform download, which is https-only because a client installs
     * what they fetch from it. Nothing is installed from here, and a regulator's
     * page still served over plain http is a real thing an operator has to be
     * able to link.
     */
    expect(assertSafeExternalUrl('  http://example.com/page  ')).toBe('http://example.com/page');
    expect(assertSafeExternalUrl('https://example.com/page')).toBe('https://example.com/page');
  });

  it('is enforced on the way in, not only in the helper', async () => {
    await expect(
      service.create({ title: 'Bad', url: 'javascript:alert(1)' }, ACTOR),
    ).rejects.toThrow(/http or https/i);

    const [calendarId] = await seedThree();
    await expect(service.update(calendarId, { url: 'javascript:alert(1)' }, ACTOR)).rejects.toThrow(
      /http or https/i,
    );
  });
});
