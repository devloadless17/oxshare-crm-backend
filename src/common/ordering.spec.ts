import { describe, expect, it } from 'vitest';
import { placeInOrder, renumber, type Ordered } from './ordering';

/** A tidy list — `0,1,2` — which is what every list should look like after any write. */
const LIST: Ordered[] = [
  { id: 'a', sortOrder: 0 },
  { id: 'b', sortOrder: 1 },
  { id: 'c', sortOrder: 2 },
];

/** Apply the changes to a list, so a test can assert the RESULTING order. */
function applied(
  items: readonly Ordered[],
  changes: { id: string; sortOrder: number }[],
): string[] {
  const byId = new Map(items.map((row) => [row.id, row.sortOrder]));
  for (const change of changes) byId.set(change.id, change.sortOrder);
  return [...byId.entries()].sort((x, y) => x[1] - y[1]).map(([id]) => id);
}

describe('placeInOrder — creating', () => {
  /*
   * The currencies bug, stated as a test. `dto.sortOrder ?? 0` put every new
   * row at the top of the list, so adding AED to a list led by USD moved USD
   * down with nothing saying so.
   */
  it('appends when no position is asked for, rather than landing on 0', () => {
    const changes = placeInOrder(LIST, 'd', undefined);

    expect(changes).toEqual([{ id: 'd', sortOrder: 3 }]);
    expect(applied(LIST, changes)).toEqual(['a', 'b', 'c', 'd']);
  });

  it('touches nobody else when it appends', () => {
    /* Only the new row is written — an append must not restamp the whole list's
       `updated_at` and bury the real edit in the audit trail. */
    expect(placeInOrder(LIST, 'd', undefined)).toHaveLength(1);
  });

  it('inserts at the asked-for position and pushes the rest down', () => {
    const changes = placeInOrder(LIST, 'd', 1);

    expect(applied(LIST, changes)).toEqual(['a', 'd', 'b', 'c']);
  });

  it('clamps a position past the end instead of refusing it', () => {
    /* 999 in a list of three means "last", and that intention is perfectly
       clear. Refusing it is a validation error about nothing. */
    expect(applied(LIST, placeInOrder(LIST, 'd', 999))).toEqual(['a', 'b', 'c', 'd']);
  });

  it('clamps a negative position to the front', () => {
    expect(applied(LIST, placeInOrder(LIST, 'd', -5))).toEqual(['d', 'a', 'b', 'c']);
  });

  it('places the first row of an empty list at 0', () => {
    expect(placeInOrder([], 'a', undefined)).toEqual([{ id: 'a', sortOrder: 0 }]);
    expect(placeInOrder([], 'a', 7)).toEqual([{ id: 'a', sortOrder: 0 }]);
  });
});

describe('placeInOrder — moving an existing row', () => {
  /*
   * THE DEFECT THIS EXISTS FOR.
   *
   * Typing a position another row already held produced a DUPLICATE, and the
   * list then fell back to its tiebreak — name or code — so the row appeared
   * somewhere the operator had not put it, with no error and nothing to undo.
   */
  it('taking a position another row holds MOVES that row, never ties with it', () => {
    const changes = placeInOrder(LIST, 'c', 0);

    expect(applied(LIST, changes)).toEqual(['c', 'a', 'b']);
    /* No two rows share a position. */
    const positions = changes.map((change) => change.sortOrder);
    expect(new Set(positions).size).toBe(positions.length);
  });

  it('moves a row down and closes the gap behind it', () => {
    expect(applied(LIST, placeInOrder(LIST, 'a', 2))).toEqual(['b', 'c', 'a']);
  });

  it('writes nothing when a row is placed where it already is', () => {
    expect(placeInOrder(LIST, 'b', 1)).toEqual([]);
  });

  it('moves a row to the end when no position is given', () => {
    expect(applied(LIST, placeInOrder(LIST, 'a', undefined))).toEqual(['b', 'c', 'a']);
  });
});

describe('placeInOrder — a list that already drifted', () => {
  /*
   * Every existing deployment has ties and gaps, because that is the bug. The
   * first write to such a list has to produce a tidy one rather than preserving
   * the mess — and it must do so DETERMINISTICALLY, or two identical requests
   * give two different lists.
   */
  const MESSY: Ordered[] = [
    { id: 'aed', sortOrder: 0 },
    { id: 'eur', sortOrder: 0 },
    { id: 'usd', sortOrder: 0 },
    { id: 'gbp', sortOrder: 40 },
  ];

  it('breaks existing ties by id, so the same input gives the same list', () => {
    const once = placeInOrder(MESSY, 'chf', 1);
    const twice = placeInOrder([...MESSY].reverse(), 'chf', 1);

    expect(once).toEqual(twice);
    expect(applied(MESSY, once)).toEqual(['aed', 'chf', 'eur', 'usd', 'gbp']);
  });

  it('leaves the list contiguous from zero, with the gap of forty closed', () => {
    const changes = placeInOrder(MESSY, 'chf', 1);
    const final = new Map(MESSY.map((row) => [row.id, row.sortOrder]));
    for (const change of changes) final.set(change.id, change.sortOrder);

    expect([...final.values()].sort((x, y) => x - y)).toEqual([0, 1, 2, 3, 4]);
  });
});

describe('renumber', () => {
  it('writes nothing for a list that is already tidy', () => {
    expect(renumber(LIST)).toEqual([]);
  });

  /*
   * Deleting position 2 of five leaves `0,1,3,4`. The gap is invisible until
   * somebody types 3 into the form and lands ON a row instead of before it.
   */
  it('closes the gap a delete leaves behind', () => {
    const afterDelete: Ordered[] = [
      { id: 'a', sortOrder: 0 },
      { id: 'b', sortOrder: 1 },
      { id: 'd', sortOrder: 3 },
      { id: 'e', sortOrder: 4 },
    ];

    expect(renumber(afterDelete)).toEqual([
      { id: 'd', sortOrder: 2 },
      { id: 'e', sortOrder: 3 },
    ]);
  });

  it('resolves ties without reordering what was already distinct', () => {
    const tied: Ordered[] = [
      { id: 'b', sortOrder: 0 },
      { id: 'a', sortOrder: 0 },
      { id: 'c', sortOrder: 5 },
    ];

    /* `a` before `b` on the id tiebreak, `c` stays last. */
    expect(applied(tied, renumber(tied))).toEqual(['a', 'b', 'c']);
  });

  it('handles an empty list', () => {
    expect(renumber([])).toEqual([]);
  });
});
