/**
 * The model ends each answer with suggested follow-up questions after a marker:
 *
 *     …the answer the client reads.
 *     <<<FOLLOWUPS>>>
 *     ["What is a stop-loss?", "How is margin calculated?"]
 *
 * The client must never see the marker or the list, yet the answer streams.
 * So `FollowupSplitter` passes text through as it arrives, EXCEPT a tail that
 * could be the start of the marker. That tail is held until it either
 * completes the marker (everything after it is the list) or stops matching
 * (released as ordinary text). Pure, no I/O, which is why it can be tested
 * chunk by chunk.
 */
export const FOLLOWUPS_MARKER = '<<<FOLLOWUPS>>>';

const MAX_FOLLOWUPS = 3;
const MAX_FOLLOWUP_LENGTH = 120;

export class FollowupSplitter {
  private held = '';
  private tail: string | null = null;

  /** Feed one delta and get back the text that is safe to show now. */
  push(delta: string): string {
    if (this.tail !== null) {
      this.tail += delta;
      return '';
    }
    const text = this.held + delta;
    const at = text.indexOf(FOLLOWUPS_MARKER);
    if (at >= 0) {
      this.held = '';
      this.tail = text.slice(at + FOLLOWUPS_MARKER.length);
      return text.slice(0, at);
    }
    const keep = partialMarkerSuffix(text);
    this.held = text.slice(text.length - keep);
    return text.slice(0, text.length - keep);
  }

  /** The stream ended: release any held text, and parse the follow-ups. */
  finish(): { text: string; followups: string[] } {
    const text = this.held;
    this.held = '';
    return { text, followups: this.tail === null ? [] : parseFollowups(this.tail) };
  }
}

/** The length of the longest suffix of `text` that is a proper prefix of the marker. */
function partialMarkerSuffix(text: string): number {
  const max = Math.min(text.length, FOLLOWUPS_MARKER.length - 1);
  for (let n = max; n > 0; n -= 1) {
    if (FOLLOWUPS_MARKER.startsWith(text.slice(text.length - n))) return n;
  }
  return 0;
}

/**
 * Lenient on purpose: a model that formats the list slightly wrong costs the
 * client the suggestions, never the answer. Anything unparseable yields none.
 */
export function parseFollowups(raw: string): string[] {
  const start = raw.indexOf('[');
  const end = raw.lastIndexOf(']');
  if (start < 0 || end <= start) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.slice(start, end + 1));
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  return parsed
    .filter((item): item is string => typeof item === 'string')
    .map((item) => item.trim())
    .filter((item) => item.length > 0 && item.length <= MAX_FOLLOWUP_LENGTH)
    .slice(0, MAX_FOLLOWUPS);
}
