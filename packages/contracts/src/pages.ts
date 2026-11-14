// Pages: a fenced html block in a reply that holds a whole document is a page.
// The client runs it beside the chat; the server sends a model only the newest
// one in full. Both read a reply's blocks here, with the fence rules the
// client's Markdown renderer uses (apps/web/src/markdown.tsx), so a block the
// renderer draws as code is the block both sides call a page.

export interface PageBlock {
  /** The code between the fences. */
  readonly code: string;
  /** The closing fence has arrived. An open block is still being written, or was cut off. */
  readonly closed: boolean;
  /** Offset of the opening fence line, and of the end of the closing fence line (the text's end while open). */
  readonly start: number;
  readonly end: number;
}

const OPEN = /^\s*```\s*([\w+#.-]*)/;
const FENCE = /^\s*```/;
const STARTS = ["<!doctype html", "<html"];

/** A whole document: it starts with a doctype or an html tag. */
export function isPageDoc(code: string): boolean {
  const head = code.trimStart().slice(0, 16).toLowerCase();
  return STARTS.some((s) => head.startsWith(s));
}

/** What has arrived of an open block can still become a document (nothing yet, or the start of one). */
export function mayBePage(code: string): boolean {
  const head = code.trimStart().slice(0, 16).toLowerCase();
  return STARTS.some((s) => head.startsWith(s) || s.startsWith(head));
}

/** Every fenced html block in `text` that is a page, or, while open, may become one. */
export function pageBlocks(text: string): PageBlock[] {
  if (!text.includes("```")) return [];
  const out: PageBlock[] = [];
  const lines = text.split(/\r\n?|\n/);
  const offsets = [0];
  for (const m of text.matchAll(/\r\n?|\n/g)) offsets.push(m.index + m[0].length);
  let i = 0;
  while (i < lines.length) {
    const open = OPEN.exec(lines[i] ?? "");
    if (open === null) {
      i++;
      continue;
    }
    const start = offsets[i] ?? 0;
    const body: string[] = [];
    i++;
    while (i < lines.length && !FENCE.test(lines[i] ?? "")) {
      if (i === lines.length - 1 && lines[i] === "") break;
      body.push(lines[i++] ?? "");
    }
    const closed = i < lines.length && FENCE.test(lines[i] ?? "");
    const end = closed ? (offsets[i] ?? 0) + (lines[i] ?? "").length : text.length;
    i++;
    if ((open[1] ?? "").toLowerCase() !== "html") continue;
    const code = body.join("\n");
    if (closed ? isPageDoc(code) : mayBePage(code)) out.push({ code, closed, start, end });
  }
  return out;
}

const ENTITIES: Readonly<Record<string, string>> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };

/** The page's `<title>`, else "Page". */
export function pageTitle(code: string): string {
  const raw = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(code)?.[1] ?? "";
  const text = raw
    .replace(/&(#x[\da-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
      if (e[0] !== "#") return ENTITIES[e.toLowerCase()] ?? m;
      const n = e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(n) && n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : m;
    })
    .replace(/\s+/g, " ")
    .trim();
  return text === "" ? "Page" : text.slice(0, 80);
}
