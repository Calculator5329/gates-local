// Measure's checks (apps/server/src/measure/cases.ts) as a model plays them: a request whose
// chat holds a check's prompt gets that check's reference calls one per round, then its answer,
// so every check runs through the app's real loop and tools. Two checks go wrong the way a
// small model's do, so a measure here shows a failed check and a page that does the wrong thing.
import { CASES, toolCallOf } from "../../apps/server/src/measure/cases.ts";

/** Checks this fake gets wrong, and what it writes instead. */
const WRONG: Readonly<Record<string, string>> = {
  "instr-caps": "Jupiter is the largest planet.",
  // The total without two decimals: 37.5, not 37.50.
  "page-total": "```html\n<!doctype html><html><body><input id=\"price\" type=\"number\"> <input id=\"qty\" type=\"number\"> <button id=\"calc\">Total</button> <span id=\"total\"></span>\n<script>document.getElementById('calc').onclick = () => { document.getElementById('total').textContent = String(Number(document.getElementById('price').value) * Number(document.getElementById('qty').value)); };</script></body></html>\n```",
};

/**
 * The counter check's page as a page that wants out: it shows the address it resolves against and
 * its referrer where the check reads the count, so what the window sends back says what it learnt.
 */
export const ADDRESS_PROBE = "```html\n<!doctype html><html><body><span id=\"count\"></span> <button id=\"add\">Add</button>\n<script>document.getElementById('count').textContent = 'at ' + document.baseURI.slice(0, 300) + ' from ' + document.referrer;</script></body></html>\n```";

type Message = { role?: unknown; content?: unknown };
export type MeasurePlay = { content: string } | { call: { name: string; arguments: Record<string, unknown> } };

/** This request's move when its chat is a Measure check, else undefined; `probe` swaps the counter page for ADDRESS_PROBE. */
export function measureReply(messages: unknown, offered: readonly string[], probe = false): MeasurePlay | undefined {
  if (!Array.isArray(messages)) return undefined;
  const list = messages as Message[];
  // The check's prompt: tool results in the text call format come back as user messages too.
  const at = list.findLastIndex((m) => m.role === "user" && CASES.some((c) => c.prompt === m.content));
  const c = CASES.find((x) => x.prompt === list[at]?.content);
  if (c === undefined) return undefined;
  if (probe && c.id === "page-counter") return { content: ADDRESS_PROBE };
  if (WRONG[c.id]) return { content: WRONG[c.id]! };
  if (c.kind === "page") return { content: c.reference.answer };
  const round = list.slice(at + 1).filter((m) => m.role === "assistant").length;
  const ref = c.reference.calls[round];
  return ref ? { call: toolCallOf(ref, offered.includes("sql")) } : { content: c.reference.answer };
}
