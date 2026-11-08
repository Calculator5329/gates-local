// A small Markdown renderer for model replies. It builds React elements and
// never sets HTML, so model text cannot inject markup. It covers what local
// models write: paragraphs, headings, lists, fenced code, tables, quotes,
// inline code, bold, italics and http(s) links. A streaming reply arrives here
// as whole blocks (reveal.ts); half-written input still renders as far as it goes.
import { type ReactNode, memo, useEffect, useState } from "react";
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

function parse(src: string): Block[] {
  const lines = src.replace(/\r\n?/g, "\n").split("\n");
  const out: Block[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i] ?? "";
    if (line.trim() === "") {
      i++;
      continue;
    }
    if (/^\s*```/.test(line)) {
      const lang = /^\s*```\s*([\w+#.-]*)/.exec(line)?.[1] ?? "";
      const body: string[] = [];
      i++;
      while (i < lines.length && !/^\s*```/.test(lines[i] ?? "")) body.push(lines[i++] ?? "");
      i++;
      out.push({ t: "code", lang, text: body.join("\n") });
      continue;
    }
    const h = /^(#{1,4})\s+(.*)$/.exec(line);
    if (h) {
      out.push({ t: "h", level: (h[1]?.length ?? 1) as 1 | 2 | 3 | 4, text: h[2] ?? "" });
      i++;
      continue;
    }
    if (line.includes("|") && isRule(lines[i + 1] ?? "")) {
      const head = cells(line);
      i += 2;
      const rows: string[][] = [];
      while (i < lines.length && (lines[i] ?? "").includes("|") && (lines[i] ?? "").trim() !== "") rows.push(cells(lines[i++] ?? ""));
      const num = head.map((_, c) => rows.length > 0 && rows.every((r) => /^[-+]?[\d.,]+\s*%?$/.test(r[c] ?? "")));
      out.push({ t: "table", head, rows, num });
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
      out.push({ t: ordered ? "ol" : "ul", items });
      continue;
    }
    if (/^\s*>/.test(line)) {
      const body: string[] = [];
      while (i < lines.length && /^\s*>/.test(lines[i] ?? "")) body.push((lines[i++] ?? "").replace(/^\s*>\s?/, ""));
      out.push({ t: "quote", text: body.join(" ") });
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
    out.push({ t: "p", text: para.join(" ") });
  }
  return out;
}

const INLINE = /(`[^`]+`)|(\*\*[^*]+\*\*)|(\*[^*\s][^*]*\*)|(\[[^\]]+\]\((https?:\/\/[^)\s]+)\))/g;

/** Inline spans: code, bold, italics, links. Anything else is text. */
export function inline(text: string): ReactNode[] {
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
      out.push(
        <a key={n++} href={m[5]} target="_blank" rel="noreferrer noopener">
          {label}
        </a>,
      );
    }
    last = at + s.length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

/** A fenced code block: the fence's language at the top left, its own copy button at the top right (shown on hover or focus). */
function CodeBlock({ lang, code }: { lang: string; code: string }) {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const t = setTimeout(() => setCopied(false), 1500);
    return () => clearTimeout(t);
  }, [copied]);
  return (
    <div className="cb">
      <div className="cb-h">
        {lang !== "" ? <span className="cb-lang">{lang}</span> : null}
        <button
          type="button"
          className={copied ? "cb-copy on" : "cb-copy"}
          aria-label="Copy code"
          data-tip={copied ? undefined : "Copy code"}
          onClick={() => {
            navigator.clipboard?.writeText(code).catch(() => undefined);
            setCopied(true);
          }}
        >
          <Icon id={copied ? "check" : "copy"} />
          {copied ? <span aria-live="polite">Copied</span> : null}
        </button>
      </div>
      <pre>
        <code>{code}</code>
      </pre>
    </div>
  );
}

function renderBlock(b: Block, key: number): ReactNode {
  switch (b.t) {
    case "p":
      return <p key={key}>{inline(b.text)}</p>;
    case "h": {
      const H = `h${b.level}` as const;
      return <H key={key}>{inline(b.text)}</H>;
    }
    case "ul":
    case "ol": {
      const L = b.t;
      return (
        <L key={key}>
          {b.items.map((it, j) => (
            <li key={j}>{inline(it)}</li>
          ))}
        </L>
      );
    }
    case "code":
      return <CodeBlock key={key} lang={b.lang} code={b.text} />;
    case "quote":
      return <blockquote key={key}>{inline(b.text)}</blockquote>;
    case "table":
      return (
        <table key={key}>
          <thead>
            <tr>
              {b.head.map((cell, j) => (
                <th key={j} className={b.num[j] ? "n" : undefined}>
                  {inline(cell)}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {b.rows.map((r, j) => (
              <tr key={j}>
                {b.head.map((_, col) => (
                  <td key={col} className={b.num[col] ? "n" : undefined}>
                    {inline(r[col] ?? "")}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      );
  }
}

/** The reply body. `live` marks a streaming reply, whose blocks fade in as they finish. */
export const Markdown = memo(function Markdown({ text, live }: { text: string; live?: boolean }) {
  return <div className={live === true ? "md live" : "md"}>{parse(text).map((b, i) => renderBlock(b, i))}</div>;
});
