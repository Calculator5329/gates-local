// Streaming display: a reply shows whole blocks, never half a sentence. The
// live turn renders reveal(text, streaming), the prefix of the text made of
// finished blocks. A paragraph or quote ends at a blank line (or where the
// next block visibly starts), a heading at its newline, a list item when the
// next item or a blank line starts, a fenced code block at its closing fence
// and a table at a blank line. Display only: the saved reply is untouched.

/** An unfinished block longer than this shows its complete lines (or sentences, or words). */
export const HOLD_LIMIT = 2000;

interface Line {
  readonly text: string;
  readonly start: number;
  /** Offset after the line break; the text's length for the last line. */
  readonly next: number;
  /** A line break follows: the line is complete. */
  readonly ended: boolean;
}

function lines(src: string): Line[] {
  const out: Line[] = [];
  let start = 0;
  for (const m of src.matchAll(/\r\n|\n|\r/g)) {
    const at = m.index ?? 0;
    out.push({ text: src.slice(start, at), start, next: at + m[0].length, ended: true });
    start = at + m[0].length;
  }
  out.push({ text: src.slice(start), start, next: src.length, ended: false });
  return out;
}

// the same block starts markdown.tsx's parser recognises
const FENCE = /^\s*```/;
const HEADING = /^#{1,4}\s/;
const ITEM = /^\s*([-*+]|\d+[.)])\s+/;
const QUOTE = /^\s*>/;
const RULE = /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/;
const CONTINUATION = /^\s{2,}/;

const blank = (l: Line) => l.text.trim() === "";

/** The prefix of `text` made of finished blocks while it streams; all of it once the stream has ended. */
export function reveal(text: string, streaming: boolean): string {
  if (!streaming) return text;
  const ls = lines(text);
  const at = (j: number): Line | undefined => ls[j];
  // a table starts only once its separator line is complete: "| --- | -" fails RULE where "| --- | " passed, so a half line would flip the decision
  const tableAt = (j: number) => {
    const sep = at(j + 1);
    return (at(j)?.text.includes("|") ?? false) && sep !== undefined && sep.ended && RULE.test(sep.text);
  };
  const startsBlock = (j: number) => {
    const t = at(j)?.text ?? "";
    return FENCE.test(t) || HEADING.test(t) || ITEM.test(t) || QUOTE.test(t) || tableAt(j);
  };
  /** Where a run of lines (paragraph, quote, table rows) ends: the first line after it, or null while undecided. */
  const runEnd = (from: number, belongs: (j: number) => boolean, firstBelongs: boolean): number | null => {
    for (let j = from; j < ls.length; j++) {
      const l = ls[j] as Line;
      if (blank(l)) return l.ended ? j : null;
      if ((j === from && firstBelongs) || belongs(j)) {
        if (!l.ended) return null;
        continue;
      }
      return l.ended || startsBlock(j) ? j : null;
    }
    return null;
  };

  let done = 0;
  let i = 0;
  scan: while (i < ls.length) {
    const l = ls[i] as Line;
    if (blank(l)) {
      if (!l.ended) break;
      i++;
      continue;
    }
    if (FENCE.test(l.text)) {
      if (!l.ended) break;
      for (let j = i + 1; j < ls.length; j++) {
        const c = ls[j] as Line;
        if (!FENCE.test(c.text)) continue;
        if (!c.ended) break scan;
        done = c.next;
        i = j + 1;
        continue scan;
      }
      break;
    }
    if (HEADING.test(l.text)) {
      if (!l.ended) break;
      done = l.next;
      i++;
      continue;
    }
    if (ITEM.test(l.text)) {
      for (let j = i + 1; ; j++) {
        const n = at(j);
        if (n === undefined) break scan;
        if (blank(n)) {
          if (!n.ended) break scan;
          done = n.start;
          i = j;
          continue scan;
        }
        if (ITEM.test(n.text)) done = n.start;
        else if (!CONTINUATION.test(n.text)) {
          done = n.start;
          i = j;
          continue scan;
        }
      }
    }
    const end = tableAt(i)
      ? runEnd(i + 2, (j) => (at(j)?.text.includes("|") ?? false), false)
      : QUOTE.test(l.text)
        ? runEnd(i, (j) => QUOTE.test(at(j)?.text ?? ""), true)
        : runEnd(i, (j) => !startsBlock(j), true);
    if (end === null) break;
    done = (ls[end] as Line).start;
    i = end;
  }

  // the safety valve: a long unfinished block shows what it can of itself
  if (text.length - done > HOLD_LIMIT) return text.slice(0, done + valveCut(text.slice(done)));
  return text.slice(0, done);
}

/** What the characters of a separator line can be: a partial line that fits this could still become one. */
const MAYBE_RULE = /^[\s|:-]*$/;

/**
 * How much of an unfinished block to show. Each step is taken only while more
 * than HOLD_LIMIT would stay hidden behind the one before it, so nothing stays
 * hidden for long and a run with no break at all still shows.
 *
 * Never shrinking depends on the hold in the first step: a finished line with a
 * bar may be a table header until the next line says otherwise, and a table
 * starts at its header, so showing that line early would take it back.
 */
function valveCut(rest: string): number {
  const ls = lines(rest);
  const partial = ls.at(-1) as Line;
  const last = ls.at(-2);
  const held = last !== undefined && last.text.includes("|") && MAYBE_RULE.test(partial.text);
  let cut = last === undefined ? 0 : held ? last.start : last.next;
  // a held header's next line may be its separator: the later steps stop short of it
  const open = held ? rest.slice(0, last.next) : rest;
  const hiding = () => rest.length - cut > HOLD_LIMIT;
  if (hiding()) cut = Math.max(cut, lastSentenceEnd(open));
  if (hiding()) cut = Math.max(cut, lastWordEnd(open));
  if (hiding()) cut = open.length;
  return cut;
}

/** After the last sentence's closing mark (and any quote or bracket), once whitespace follows it; 0 if none. */
function lastSentenceEnd(s: string): number {
  let end = 0;
  for (const m of s.matchAll(/[.!?…]+["'”’)\]]*(?=\s)/g)) end = (m.index ?? 0) + m[0].length;
  return end;
}

/** After the last whitespace, the end of the last complete word; 0 if none. */
function lastWordEnd(s: string): number {
  for (let i = s.length - 1; i >= 0; i--) if (/\s/.test(s[i] ?? "")) return i + 1;
  return 0;
}
