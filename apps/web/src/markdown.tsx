// A small Markdown renderer for model replies. It builds React elements and
// never sets HTML, so model text cannot inject markup. It covers what local
// models write: paragraphs, headings, lists, fenced code, tables, quotes,
// inline code, bold, italics and http(s) links. A streaming reply arrives here
// at a steady pace; incomplete inline spans render without their delimiters.
import { type ReactNode, memo, useEffect, useRef } from "react";
import { useCopy } from "./copy.ts";
import { linkKey } from "@gates-local/contracts";
import { Icon } from "./icons.tsx";

type Block =
  | { t: "p"; text: string }
  | { t: "h"; level: 1 | 2 | 3 | 4; text: string }
  | { t: "ul" | "ol"; items: string[] }
  | { t: "code"; lang: string; text: string }
  | { t: "quote"; text: string }
  | { t: "table"; head: string[]; rows: string[][]; num: boolean[] };

const cells = (line: string) =>
  line
    .trim()
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split("|")
    .map((c) => c.trim());

const isRule = (line: string) => /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(line);

function parse(src: string): { block: Block; start: number; stable: boolean }[] {
  const lines = src.split(/\r\n?|\n/);
  const offsets = [0];
  for (const m of src.matchAll(/\r\n?|\n/g)) offsets.push(m.index + m[0].length);
  const out: { block: Block; start: number; stable: boolean }[] = [];
  let i = 0;
  let start = 0;
  // A partial next line can still extend a list/table/quote. Keep that
  // predecessor mutable until the boundary is known, not just the last row.
  const push = (block: Block, stable = i < lines.length - 1) => out.push({ block, start: offsets[start] ?? 0, stable });
  while (i < lines.length) {
    start = i;
    const line = lines[i] ?? "";
    if (line.trim() === "") {
      i++;
      continue;
    }
    if (/^\s*```/.test(line)) {
      const lang = /^\s*```\s*([\w+#.-]*)/.exec(line)?.[1] ?? "";
      const body: string[] = [];
      i++;
      while (i < lines.length && !/^\s*```/.test(lines[i] ?? "")) {
        if (i === lines.length - 1 && lines[i] === "") break;
        body.push(lines[i++] ?? "");
      }
      const closed = i < lines.length && /^\s*```/.test(lines[i] ?? "");
      i++;
      push({ t: "code", lang, text: body.join("\n") }, closed);
      continue;
    }
    const h = /^(#{1,4})\s+(.*)$/.exec(line);
    if (h) {
      i++;
      push({ t: "h", level: (h[1]?.length ?? 1) as 1 | 2 | 3 | 4, text: h[2] ?? "" }, i < lines.length);
      continue;
    }
    if (line.includes("|") && isRule(lines[i + 1] ?? "")) {
      const head = cells(line);
      i += 2;
      const rows: string[][] = [];
      while (i < lines.length && (lines[i] ?? "").includes("|") && (lines[i] ?? "").trim() !== "") rows.push(cells(lines[i++] ?? ""));
      const num = head.map((_, c) => rows.length > 0 && rows.every((r) => /^[-+]?[\d.,]+\s*%?$/.test(r[c] ?? "")));
      push({ t: "table", head, rows, num });
      continue;
    }
    const list = /^\s*([-*+]|\d+[.)])\s+/.exec(line);
    if (list) {
      const ordered = /\d/.test(list[1] ?? "");
      const items: string[] = [];
      while (i < lines.length) {
        const m = /^\s*([-*+]|\d+[.)])\s+(.*)$/.exec(lines[i] ?? "");
        if (m) items.push(m[2] ?? "");
        else if ((lines[i] ?? "").trim() !== "" && /^\s{2,}/.test(lines[i] ?? "") && items.length > 0) items[items.length - 1] += ` ${(lines[i] ?? "").trim()}`;
        else break;
        i++;
      }
      push({ t: ordered ? "ol" : "ul", items });
      continue;
    }
    if (/^\s*>/.test(line)) {
      const body: string[] = [];
      while (i < lines.length && /^\s*>/.test(lines[i] ?? "")) body.push((lines[i++] ?? "").replace(/^\s*>\s?/, ""));
      push({ t: "quote", text: body.join(" ") });
      continue;
    }
    const para: string[] = [];
    while (i < lines.length) {
      const l = lines[i] ?? "";
      if (l.trim() === "" || /^\s*```/.test(l) || /^#{1,4}\s/.test(l) || /^\s*([-*+]|\d+[.)])\s+/.test(l) || /^\s*>/.test(l)) break;
      if (l.includes("|") && isRule(lines[i + 1] ?? "")) break;
      para.push(l.trim());
      i++;
    }
    push({ t: "p", text: para.join(" ") });
  }
  return out;
}

const INLINE = /(`[^`]+`)|(\*\*[^*]+\*\*)|(\*[^*\s][^*]*\*)|(\[[^\]]+\]\((https?:\/\/[^)\s]+)\))|(https?:\/\/[^\s<>)\]]+)|!\[([^\]]*)\]\((?:[^()\n]|\([^()]*\))*\)/g;

/** A URL with a break offered after each / and - (and inside a run too long to fit), so a line never ends mid-word. */
function wrapUrl(url: string): ReactNode[] {
  return (url.match(/[^/-]{1,32}[/-]?|[/-]/g) ?? [url]).flatMap((part, i) => (i === 0 ? [part] : [<wbr key={i} />, part]));
}

/** Inline spans: code, bold, italics, links and bare URLs. Anything else is text. */
export function inline(text: string, partial = false, allowedLinks?: ReadonlySet<string>): ReactNode[] {
  if (partial) {
    // Skip closed inline code and links before looking for a pending destination.
    // Keep just the label, whose width also matches the eventual anchor.
    const pending = /`[^`]*(?:`|$)|\[[^\]]+\]\([^)]*\)|(\[([^\]]+)\]\([^)]*$)/g;
    for (const m of text.matchAll(pending)) if (m[1]) return [...inline(text.slice(0, m.index), true, allowedLinks), m[2]];
  }
  if (partial) for (const m of text.matchAll(/`[^`]+`|\*\*[^*]+\*\*|\*[^*\s][^*]*\*|(\*\*|\*|`)/g)) {
    const mark = m[1];
    if (mark === undefined) continue;
    const before = inline(text.slice(0, m.index), false, allowedLinks);
    const Tag = mark === "`" ? "code" : mark === "**" ? "strong" : "em";
    const body = text.slice(m.index + mark.length);
    return [...before, <Tag key={before.filter((x) => typeof x === "object").length}>{mark === "**" ? body.replace(/\*$/, "") : body}</Tag>];
  }
  const out: ReactNode[] = [];
  let last = 0;
  let n = 0;
  for (const m of text.matchAll(INLINE)) {
    const at = m.index ?? 0;
    if (at > last) out.push(text.slice(last, at));
    const s = m[0];
    if (m[1]) out.push(<code key={n++}>{s.slice(1, -1)}</code>);
    else if (m[2]) out.push(<strong key={n++}>{s.slice(2, -2)}</strong>);
    else if (m[3]) out.push(<em key={n++}>{s.slice(1, -1)}</em>);
    else if (m[4]) {
      const label = s.slice(1, s.indexOf("]("));
      const url = m[5] ?? "";
      if (allowedLinks !== undefined && !allowedLinks.has(linkKey(url) ?? "")) {
        out.push(<span key={n++}>{label} ({wrapUrl(url)})</span>);
        last = at + s.length;
        continue;
      }
      const isUrl = /^https?:\/\//.test(label);
      out.push(
        <a key={n++} href={m[5]} className={isUrl ? "url" : undefined} data-testid="chat.markdown.link" target="_blank" rel="noreferrer noopener">
          {isUrl ? wrapUrl(label) : label}
        </a>,
      );
    } else if (m[7] !== undefined) {
      // Model-authored image URLs are untrusted, including local-looking ones.
      // Actual generated files render only from the message's server-owned images.
      out.push(m[7] || "Image unavailable");
    } else {
      // a sentence's closing punctuation stays outside the link
      const url = s.replace(/[.,;:!?]+$/, "");
      out.push(allowedLinks !== undefined && !allowedLinks.has(linkKey(url) ?? "") ? <span key={n++} className="url">{wrapUrl(url)}</span> : (
        <a key={n++} href={url} className="url" data-testid="chat.markdown.url" target="_blank" rel="noreferrer noopener">
          {wrapUrl(url)}
        </a>
      ));
      last = at + url.length;
      continue;
    }
    last = at + s.length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

/** Marks which sides of a sideways-scrolling block have more to show (`data-more`), for the edge fade on small screens. */
function useEdges<T extends HTMLElement>(content: unknown) {
  const ref = useRef<T>(null);
  useEffect(() => {
    const el = ref.current;
    // only below 1024 px, and measured from the observer: a read here would lay out every block of a long thread at once
    if (el === null || !window.matchMedia("(max-width: 1023px)").matches) return;
    const mark = () => {
      const sides = [el.scrollLeft > 1 ? "start" : "", el.scrollLeft < el.scrollWidth - el.clientWidth - 1 ? "end" : ""].filter((x) => x !== "").join(" ");
      if (sides === "") delete el.dataset.more;
      else el.dataset.more = sides;
    };
    el.addEventListener("scroll", mark, { passive: true });
    const seen = new ResizeObserver(mark);
    seen.observe(el);
    return () => {
      el.removeEventListener("scroll", mark);
      seen.disconnect();
    };
  }, [content]);
  return ref;
}

/** A fenced code block: the fence's language at the top left, its own copy button at the top right (shown on hover or focus). */
function CodeBlock({ lang, code }: { lang: string; code: string }) {
  const [copied, copy] = useCopy(code);
  const pre = useEdges<HTMLPreElement>(code);
  return (
    <div className="cb">
      <div className="cb-h">
        {lang !== "" ? <span className="cb-lang">{lang}</span> : null}
        <button
          type="button"
          className={copied !== null ? "cb-copy on" : "cb-copy"}
          data-testid="chat.markdown.copy-code"
          aria-label="Copy code"
          data-tip={copied !== null ? undefined : "Copy code"}
          onClick={copy}
        >
          <Icon id={copied ? "check" : "copy"} />
          {copied !== null ? <span role="status">{copied ? "Copied" : "Couldn't copy"}</span> : null}
        </button>
      </div>
      <pre ref={pre}>
        <code>{code}</code>
      </pre>
    </div>
  );
}

function Table({ b, partial, allowedLinks }: { b: Extract<Block, { t: "table" }>; partial: boolean; allowedLinks?: ReadonlySet<string> }) {
  const ref = useEdges<HTMLTableElement>(b.rows.length);
  return (
    <table ref={ref}>
      <thead>
        <tr>
          {b.head.map((cell, j) => (
            <th key={j} className={b.num[j] ? "n" : undefined}>
              {inline(cell, partial, allowedLinks)}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {b.rows.map((r, j) => (
          <tr key={j}>
            {b.head.map((_, col) => (
              <td key={col} className={b.num[col] ? "n" : undefined}>
                {inline(r[col] ?? "", partial, allowedLinks)}
              </td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

// Completed blocks retain their objects and React elements across live frames.
const MarkdownBlock = memo(function MarkdownBlock({ b, partial, allowedLinks }: { b: Block; partial: boolean; allowedLinks?: ReadonlySet<string> }) {
  switch (b.t) {
    case "p":
      return <p>{inline(b.text, partial, allowedLinks)}</p>;
    case "h": {
      const H = `h${b.level}` as const;
      return <H>{inline(b.text, partial, allowedLinks)}</H>;
    }
    case "ul":
    case "ol": {
      const L = b.t;
      return (
        <L>
          {b.items.map((it, j) => (
            <li key={j}>{inline(it, partial, allowedLinks)}</li>
          ))}
        </L>
      );
    }
    case "code":
      return <CodeBlock lang={b.lang} code={b.text} />;
    case "quote":
      return <blockquote>{inline(b.text, partial, allowedLinks)}</blockquote>;
    case "table":
      return <Table b={b} partial={partial} allowedLinks={allowedLinks} />;
  }
});

/** Live text is append-only. Keep a suffix mutable, since its next line
 * can extend a paragraph/list or turn a header into a table. A replacement or
 * historical edit explicitly resets the cache. Offsets refer to raw CRLF too. */
export function createMarkdownParser() {
  let source = "";
  let offset = 0;
  let completed: Block[] = [];
  let blocks: Block[] = [];
  return (text: string, appendOnly = true): { blocks: Block[]; retained: number } => {
    if (text === source) return { blocks, retained: blocks.length };
    if (!appendOnly || text.length <= source.length) { offset = 0; completed = []; }
    const retained = completed.length;
    const suffix = parse(text.slice(offset));
    blocks = completed.concat(suffix.map((entry) => entry.block));
    const mutable = suffix.findIndex((entry, i) => !entry.stable || i === suffix.length - 1);
    if (mutable >= 0) {
      offset += suffix[mutable]!.start;
      completed = completed.concat(suffix.slice(0, mutable).map((entry) => entry.block));
    }
    source = text;
    return { blocks, retained };
  };
}

/** Only the changing suffix is parsed and given new elements each live frame. */
export const Markdown = memo(function Markdown({ text, live, allowedLinks }: { text: string; live?: boolean; allowedLinks?: ReadonlySet<string> }) {
  const parser = useRef<ReturnType<typeof createMarkdownParser> | null>(null);
  parser.current ??= createMarkdownParser();
  const previous = useRef<{ live: boolean | undefined; allowedLinks: ReadonlySet<string> | undefined; rows: ReactNode[] }>({ live, allowedLinks, rows: [] });
  const result = parser.current(text, live === true);
  // A late tool result can grant or revoke a completed block's links. Rebuild
  // its element too, so memo sees the new provenance even with unchanged text.
  const retained = live === previous.current.live && allowedLinks === previous.current.allowedLinks ? result.retained : 0;
  const rows = previous.current.rows.slice(0, retained);
  for (let i = retained; i < result.blocks.length; i++) rows.push(<MarkdownBlock key={i} b={result.blocks[i]!} partial={live === true} allowedLinks={allowedLinks} />);
  previous.current = { live, allowedLinks, rows };
  return <div className={live === true ? "md live" : "md"}>{rows}</div>;
});
