// Pages a model writes (packages/contracts/src/pages.ts): the standing rule that
// gets a follow-up to send the whole page again, and what a model is sent of
// the pages earlier in the thread. The thread on disk keeps every version.
import { pageBlocks, pageTitle } from "@gates-local/contracts";

/**
 * Sent with every chat turn: the turn that first asks for a page cannot be told
 * apart in advance, and a follow-up needs the rule to send the whole page again.
 * 235 characters: 63 tokens by the app's own estimate (chat/window.ts).
 */
export const PAGE_RULE =
  "When asked for a page, app, tool or chart to use here, reply with one complete HTML document in one ```html block, with its CSS and JavaScript inline and no outside files, links or requests. To change a page, send the whole page again.";

/** One short line in place of an older version of a page. */
export const pageStandIn = (title: string): string => `[An earlier version of the page "${title}" was here.]`;

/**
 * The thread as a model is sent it: only the newest page's code in full; every
 * older closed page block becomes one stand-in line. At a 16k window three
 * versions of a page would otherwise push the conversation out.
 */
export function condensePages<M extends { readonly role: string; readonly content: string }>(messages: readonly M[]): M[] {
  let newest: { at: number; start: number } | undefined;
  for (const [at, m] of messages.entries()) {
    if (m.role !== "assistant") continue;
    const closed = pageBlocks(m.content).filter((b) => b.closed);
    const last = closed.at(-1);
    if (last !== undefined) newest = { at, start: last.start };
  }
  if (newest === undefined) return [...messages];
  const keep = newest;
  return messages.map((m, at) => {
    if (m.role !== "assistant" || at > keep.at) return m;
    const older = pageBlocks(m.content).filter((b) => b.closed && !(at === keep.at && b.start === keep.start));
    if (older.length === 0) return m;
    let content = "";
    let from = 0;
    for (const b of older) {
      content += m.content.slice(from, b.start) + pageStandIn(pageTitle(b.code));
      from = b.end;
    }
    return { ...m, content: content + m.content.slice(from) };
  });
}
