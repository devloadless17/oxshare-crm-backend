/**
 * Where a catalogue row sits in its list, and what happens to the rest when it
 * moves.
 *
 * ## The three behaviours this replaces
 *
 * Four admin catalogues carry a `sort_order` and each answered "what order does
 * a NEW row get" differently:
 *
 *   currencies  `dto.sortOrder ?? 0`      — every new currency landed on 0, so
 *                                           the list was a pile of ties broken
 *                                           by code. Adding AED silently moved
 *                                           it above USD.
 *   leverages   `max + 10`                — appended, with gaps of ten that no
 *                                           screen explained and no control
 *                                           could close.
 *   products    required from the caller  — the form sent a number the operator
 *   agencies    required from the caller    typed, and nothing stopped two rows
 *                                           holding the same one.
 *
 * All three share the real defect: **typing a position another row already
 * holds did not move that row.** It produced a duplicate, and the list then
 * ordered by the tiebreak — name or code — so the row appeared somewhere the
 * operator did not put it, with no error and nothing to undo.
 *
 * ## What this does instead
 *
 * One rule for all four: a list is always `0, 1, 2 … n-1` with no ties and no
 * gaps. Placing a row AT a position inserts it there and pushes the rest down,
 * exactly like dragging a row in a list — which is the mental model an operator
 * already has and the one the number was pretending to offer.
 *
 * ## Why a pure function
 *
 * Same reason `money.ts` and `commission.ts` are pure seams: no Nest, no
 * Drizzle, no `store/`. Every edge case here is an off-by-one — moving up
 * versus down, a position past the end, a row that has not been created yet —
 * and each is one assertion with no container. The services call it and write
 * what it returns.
 */

/** The shape every orderable catalogue row shares. */
export interface Ordered {
  id: string;
  sortOrder: number;
}

/** A row whose stored position must change, and what it must change to. */
export interface OrderChange {
  id: string;
  sortOrder: number;
}

/**
 * Where a row should sit, and every row that has to move to let it.
 *
 * @param items    Every row in the list AS STORED, in any order. For a CREATE
 *                 this is the list before the new row exists.
 * @param targetId The row being placed. May be absent from `items` — that is a
 *                 create, and the returned change for it is the position the
 *                 caller should insert with.
 * @param desired  The position the operator asked for, or `undefined` for
 *                 "wherever" — which means the END. Appending is the only
 *                 answer that does not move somebody else's row for a request
 *                 that expressed no opinion.
 *
 * @returns Only the rows whose `sortOrder` actually CHANGES, plus the target.
 *          A caller writes exactly these and touches nothing else, so adding a
 *          currency at the end does not rewrite every other row's `updated_at`
 *          and bury the real edit in the audit trail.
 */
export function placeInOrder(
  items: readonly Ordered[],
  targetId: string,
  desired: number | undefined,
): OrderChange[] {
  /*
   * Sorted by stored position, ties broken by id.
   *
   * The tiebreak is what makes this DETERMINISTIC on a list that already has
   * duplicates — which every existing deployment has, because that is the bug
   * being fixed. Without it two rows sharing position 0 could come back in
   * either order and the first renumber would be a coin toss.
   */
  const ordered = [...items].sort((a, b) =>
    a.sortOrder === b.sortOrder ? a.id.localeCompare(b.id) : a.sortOrder - b.sortOrder,
  );

  const without = ordered.filter((row) => row.id !== targetId);

  /*
   * Clamped, never rejected. An operator typing 999 into a list of four means
   * "put it last", and refusing that is a validation error about an intention
   * that was perfectly clear. The DTO still bounds the raw input; this bounds
   * it against the list that actually exists.
   */
  const index =
    desired === undefined ? without.length : Math.max(0, Math.min(desired, without.length));

  const placed: string[] = [
    ...without.slice(0, index).map((row) => row.id),
    targetId,
    ...without.slice(index).map((row) => row.id),
  ];

  const stored = new Map(ordered.map((row) => [row.id, row.sortOrder]));

  return placed
    .map((id, position) => ({ id, sortOrder: position }))
    .filter((change) => stored.get(change.id) !== change.sortOrder);
}

/**
 * The positions a list should hold, for a list that has drifted.
 *
 * Used after a DELETE and on any list carrying the ties or gaps the old
 * behaviour left behind. It renumbers `0 … n-1` in the current visible order
 * and reports only what moves, so calling it on an already-tidy list is free
 * and writes nothing.
 *
 * Deletion needs it because removing position 2 of five leaves `0,1,3,4` — a
 * gap that is invisible until somebody types 3 into the form and lands on top
 * of a row instead of before it.
 */
export function renumber(items: readonly Ordered[]): OrderChange[] {
  const ordered = [...items].sort((a, b) =>
    a.sortOrder === b.sortOrder ? a.id.localeCompare(b.id) : a.sortOrder - b.sortOrder,
  );

  return ordered
    .map((row, position) => ({ id: row.id, sortOrder: position }))
    .filter((change, position) => ordered[position].sortOrder !== change.sortOrder);
}
