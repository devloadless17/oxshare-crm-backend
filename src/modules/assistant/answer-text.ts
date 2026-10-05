/**
 * Web-search residue removed from an answer before it is stored.
 *
 * With web search the model sometimes writes its citations into the text:
 * OpenAI's inline form, `([investing.com](https://…))`, and, now and then, a
 * raw citation marker in private-use characters, `citeturn0search0`.
 * The pages are already kept in `sources`, so neither belongs in the words a
 * reopened chat shows. The portal strips the same while the answer streams.
 */
const INLINE_CITATION = / ?\(\s*\[[^\]\n]{1,120}\]\(https?:\/\/[^)\s]+\)\s*\)/g;
const CITATION_MARKER = /[^]*/g;

export function withoutCitations(text: string): string {
  return text.replace(CITATION_MARKER, '').replace(INLINE_CITATION, '');
}
