/**
 * MT5's numeric position side, named.
 *
 * ## Why this is shared rather than a const in one service
 *
 * There are two paths to a client's positions table now — the polled read
 * (`TradingService.positionsMine`) and the pushed one (`Mt5LiveService`) — and
 * they render into the SAME table through the same DTO. A private copy of this
 * map in each is two definitions of one word, and the failure they produce is
 * not an error: a position pushed with one vocabulary and polled with another
 * flips its own Side column depending on which delivery arrived last.
 *
 * That is precisely what shipped when the live path was added and omitted
 * `side` entirely: the pushed rows carried MT5's raw `action` and no label, so
 * the column emptied itself the moment a reading arrived over the socket.
 *
 * ## An unknown code is rendered, not blanked
 *
 * `action 7` rather than an empty cell, and the rule is the same one
 * `dealActionLabel` follows for deals. A client can quote an unfamiliar code to
 * support; a blank cell beside a real volume and a real profit is what generates
 * the ticket in the first place.
 */
const NAMED_SIDES: Record<number, string> = { 0: 'buy', 1: 'sell' };

export function positionSideLabel(action: number): string {
  return NAMED_SIDES[action] ?? `action ${action}`;
}
