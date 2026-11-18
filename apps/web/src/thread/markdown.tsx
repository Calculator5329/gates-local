import { type ReactNode, memo, useCallback, useRef, useState } from "react";
import { useCopy } from "../lib/ui/copy.ts";
import { observeBox } from "../lib/ui/kit/events.ts";
import { isPageDoc, linkKey, mayBePage } from "@gates-local/contracts";
import { Icon } from "../lib/ui/icons.tsx";
import { PageChip, WritingChip } from "../pages/PageChip.tsx";

type Block =
  | { t: "p"; text: string }
  | { t: "h"; level: 1 | 2 | 3 | 4; text: string }
  | { t: "ul" | "ol"; items: string[] }
  | { t: "code"; lang: string; text: string; closed: boolean }
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
      push({ t: "code", lang, text: body.join("\n"), closed }, closed);
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

function wrapUrl(url: string): ReactNode[] {
  return (url.match(/[^/-]{1,32}[/-]?|[/-]/g) ?? [url]).flatMap((part, i) => (i === 0 ? [part] : [<wbr key={i} />, part]));
}

export function inline(text: string, partial = false, allowedLinks?: ReadonlySet<string>): ReactNode[] {
  if (partial) {
    // why: the label alone is as wide as the link it will become
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
      out.push(m[7] || "Image unavailable");
    } else {
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

function markEdges(el: HTMLElement): void {
  const sides = [el.scrollLeft > 1 ? "start" : "", el.scrollLeft < el.scrollWidth - el.clientWidth - 1 ? "end" : ""].filter((x) => x !== "").join(" ");
  if (sides === "") delete el.dataset.more;
  else el.dataset.more = sides;
}

// why: a new callback per content, so a block whose content changes is read again
function useEdges<T extends HTMLElement>(content: unknown) {
  return useCallback((el: T | null) => {
    // why: reading the size here would lay out every block of a long thread at once
    if (el === null || !window.matchMedia("(max-width: 1023px)").matches) return undefined;
    return observeBox(el, () => markEdges(el), { atOnce: false });
  }, [content]);
}

function CodeBlock({ lang, code }: { lang: string; code: string }) {
  const [copied, copy] = useCopy(code);
  const pre = useEdges<HTMLPreElement>(code);
  // why: under 420 px an unwrapped command is cut mid-token; the toggle still unwraps it
  const [wrap, setWrap] = useState(() => typeof matchMedia === "function" && matchMedia("(max-width: 419px)").matches);
  return (
    <div className="cb">
      <div className="cb-h">
        {lang !== "" ? <span className="cb-lang">{lang}</span> : null}
        <button type="button" className="cb-wrap" data-testid="chat.markdown.wrap-code" aria-label="Wrap lines" data-tip="Wrap lines" aria-pressed={wrap} onClick={() => setWrap((w) => !w)}>
          <Icon id="wrap" />
        </button>
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
      <pre ref={pre} className={wrap ? "wrap" : undefined}>
        <code>{code}</code>
      </pre>
    </div>
  );
}

const SHORT_CELL = 32;

function Table({ b, partial, allowedLinks }: { b: Extract<Block, { t: "table" }>; partial: boolean; allowedLinks?: ReadonlySet<string> }) {
  const ref = useEdges<HTMLTableElement>(b.rows.length);
  // why: a short column holds one line on a phone, so a sideways cut lands in its words
  const kind = b.head.map((h, c) => {
    const short = [h, ...b.rows.map((r) => r[c] ?? "")].every((t) => t.length <= SHORT_CELL);
    return [b.num[c] ? "n" : "", short ? "s" : ""].filter(Boolean).join(" ") || undefined;
  });
  // why: a phone stacks each row as a card, and each line there names its column
  const label = b.head.map((h) => h.replaceAll(/[*_`]/g, "").trim());
  return (
    <table ref={ref}>
      <thead>
        <tr>
          {b.head.map((cell, j) => (
            <th key={j} className={kind[j]}>
              {inline(cell, partial, allowedLinks)}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {b.rows.map((r, j) => (
          <tr key={j}>
            {b.head.map((_, col) => (
              <td key={col} className={kind[col]} data-label={label[col]}>
                <span>{inline(r[col] ?? "", partial, allowedLinks)}</span>
              </td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

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
      if (b.lang.toLowerCase() === "html") {
        if (b.closed && isPageDoc(b.text)) return <PageChip code={b.text} />;
        if (!b.closed && partial && mayBePage(b.text)) return <WritingChip code={b.text} />;
      }
      return <CodeBlock lang={b.lang} code={b.text} />;
    case "quote":
      return <blockquote>{inline(b.text, partial, allowedLinks)}</blockquote>;
    case "table":
      return <Table b={b} partial={partial} allowedLinks={allowedLinks} />;
  }
});

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

export const Markdown = memo(function Markdown({ text, live, allowedLinks }: { text: string; live?: boolean; allowedLinks?: ReadonlySet<string> }) {
  const parser = useRef<ReturnType<typeof createMarkdownParser> | null>(null);
  parser.current ??= createMarkdownParser();
  const previous = useRef<{ live: boolean | undefined; allowedLinks: ReadonlySet<string> | undefined; rows: ReactNode[] }>({ live, allowedLinks, rows: [] });
  const result = parser.current(text, live === true);
  const retained = live === previous.current.live && allowedLinks === previous.current.allowedLinks ? result.retained : 0;
  const rows = previous.current.rows.slice(0, retained);
  for (let i = retained; i < result.blocks.length; i++) rows.push(<MarkdownBlock key={i} b={result.blocks[i]!} partial={live === true} allowedLinks={allowedLinks} />);
  previous.current = { live, allowedLinks, rows };
  return <div className={live === true ? "md live" : "md"}>{rows}</div>;
});
