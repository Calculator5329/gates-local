// The finder's sheet: one card per finding, the frame before and after side
// by side with the element outlined, and a small timeline of the change.
// Findings only; a clean step shows nothing. Dark, no gradients, one column
// on a phone.
import type { Finding } from "./detectors.ts";
import { NAMES } from "./screens.ts";

export type Found = Finding & { readonly pics: readonly (string | null)[] };
export interface SheetStep { readonly name: string; readonly frames: number; readonly ms: number; readonly findings: readonly Found[]; readonly broken?: string }
export interface SheetScreen { readonly id: string; readonly name: string; readonly seconds: number; readonly size?: { readonly width: number; readonly height: number }; readonly steps: readonly SheetStep[] }
export interface Sheet { readonly title: string; readonly made: string; readonly seconds: number; readonly screens: readonly SheetScreen[] }

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

/** A tracked box's key in words: "composer action Dictate", not ".cf-r > * Dictate". */
export function nameOf(key: string): string {
  for (const [sel, name] of Object.entries(NAMES).toSorted((a, b) => b[0].length - a[0].length)) {
    if (key === sel) return name;
    if (key.startsWith(`${sel} `)) return `${name} ${key.slice(sel.length + 1)}`.trim();
  }
  return key.replace(/^[.#]/, "");
}

export function headline(f: Finding): string {
  const name = nameOf(f.element);
  switch (f.kind) {
    case "moves": return `${name} moves ${f.px ?? 0} px`;
    case "flicker": return `${name} flickers: gone ${f.ms ?? 0} ms, then back`;
    case "late": return `${name} arrives ${f.ms ?? 0} ms after the rest`;
    case "twice": return `says ${f.element} twice`;
    case "cut": return `${name} is cut off by ${f.px ?? 0} px`;
    case "error": return "console error";
  }
}

/** The same thing found on several steps of one screen is one card. */
export function unique(screens: readonly SheetScreen[]): Found[] {
  const seen = new Set<string>();
  const out: Found[] = [];
  for (const s of screens) for (const step of s.steps) for (const f of step.findings) {
    const key = f.kind === "twice" || f.kind === "cut" || f.kind === "error" ? `${s.id}|${f.kind}|${f.element}|${f.detail}` : `${s.id}|${f.step}|${f.kind}|${f.element}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(f);
  }
  return out;
}

function timeline(f: Finding): string {
  const pts = f.series ?? [];
  if (pts.length < 2) return "";
  const W = 320, H = 56, P = 6;
  const xs = pts.map((p) => p[0]), ys = pts.map((p) => p[1]);
  const x0 = Math.min(...xs), x1 = Math.max(...xs, x0 + 1), y0 = Math.min(...ys), y1 = Math.max(...ys, y0 + 1);
  const X = (v: number) => P + ((v - x0) / (x1 - x0)) * (W - 2 * P);
  const Y = (v: number) => H - P - ((v - y0) / (y1 - y0)) * (H - 2 * P);
  // a step line: the value holds until the next frame
  let d = `M${X(pts[0]![0]).toFixed(1)},${Y(pts[0]![1]).toFixed(1)}`;
  for (let i = 1; i < pts.length; i++) d += ` H${X(pts[i]![0]).toFixed(1)} V${Y(pts[i]![1]).toFixed(1)}`;
  const mark = f.ms === undefined ? "" : `<line x1="${X(f.ms).toFixed(1)}" x2="${X(f.ms).toFixed(1)}" y1="0" y2="${H}" class="tl-at"/>`;
  const unit = f.kind === "flicker" ? "shown" : "px";
  const lo = f.kind === "flicker" ? "gone" : `${y0}`, hi = f.kind === "flicker" ? "shown" : `${y1}`;
  return `<figure class="tl"><svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(`${unit} over time`)}">${mark}<path d="${d}"/></svg>
<figcaption><span>${esc(hi)}</span><span>${esc(lo)}</span><span>${x0} ms</span><span>${x1} ms</span></figcaption></figure>`;
}

function frame(pic: string | null, boxes: readonly (readonly number[])[], size: { width: number; height: number }, label: string): string {
  if (!pic) return `<div class="shot none">${esc(label)}: no frame</div>`;
  const outline = boxes.map((b) => {
    const [x = 0, y = 0, w = 0, h = 0] = b;
    return `<i style="left:${(x / size.width * 100).toFixed(2)}%;top:${(y / size.height * 100).toFixed(2)}%;width:${Math.max(0.4, w / size.width * 100).toFixed(2)}%;height:${Math.max(0.4, h / size.height * 100).toFixed(2)}%"></i>`;
  }).join("");
  return `<figure class="shot"><div class="pic"><img src="${esc(pic)}" alt="${esc(label)}" loading="lazy">${outline}</div><figcaption>${esc(label)}</figcaption></figure>`;
}

function card(f: Found, screen: SheetScreen): string {
  const size = screen.size ?? { width: 1440, height: 900 };
  const pics = f.pics;
  // before and after: the first and the frame it changed on (the last for a flicker's return)
  const shots = f.kind === "flicker"
    ? [frame(pics[0] ?? null, [f.boxes[0] ?? []], size, "shown"), frame(pics[1] ?? null, [f.boxes[0] ?? []], size, "gone"), frame(pics[2] ?? null, [f.boxes[1] ?? []], size, "back")]
    : f.kind === "moves" || f.kind === "late"
      ? [frame(pics[0] ?? null, [f.boxes[0] ?? []], size, "before"), frame(pics[1] ?? null, [f.boxes[1] ?? f.boxes[0] ?? []], size, "after")]
      : [frame(pics[0] ?? null, f.boxes, size, "at the end of the step")];
  return `<article class="card k-${f.kind}">
<header><span class="kind">${esc(f.kind)}</span><h2>${esc(headline(f))}</h2></header>
<p class="where">${esc(screen.name)} › ${esc(f.step)}${f.ms !== undefined && f.kind !== "flicker" && f.kind !== "late" ? ` · ${f.ms} ms after the action` : ""}</p>
<p class="detail">${esc(f.detail)}</p>
<div class="shots n${shots.length}">${shots.join("")}</div>
${timeline(f)}
<p class="frames">frames ${f.frames.join(", ")}</p>
</article>`;
}

export function renderSheet(sheet: Sheet): string {
  const found = unique(sheet.screens);
  const byScreen = new Map(sheet.screens.map((s) => [s.id, s]));
  const broken = sheet.screens.flatMap((s) => s.steps.filter((st) => st.broken).map((st) => `${s.name} › ${st.name}: ${st.broken}`));
  const walked = sheet.screens.reduce((n, s) => n + s.steps.length, 0);
  const cards = found.map((f) => card(f, byScreen.get(f.screen)!)).join("\n");
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Bug finder</title>
<style>
:root{--bg:#0d0f0e;--card:#151917;--line:#2a302d;--fg:#e6ebe8;--dim:#9aa59f;--accent:#5fd38a;--mark:#ff5a4f;color-scheme:dark}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.45 system-ui,-apple-system,"Segoe UI",sans-serif}
main{max-width:1180px;margin:0 auto;padding:20px 16px 48px}
h1{font-size:20px;margin:0 0 4px}
.sum{color:var(--dim);margin:0 0 20px}
.card{background:var(--card);border:1px solid var(--line);border-radius:6px;padding:14px;margin:0 0 16px}
.card header{display:flex;gap:10px;align-items:baseline}
.card h2{font-size:16px;margin:0;font-weight:600}
.kind{font:600 11px/1 ui-monospace,monospace;text-transform:uppercase;color:var(--bg);background:var(--accent);padding:3px 6px;border-radius:3px;flex:none}
.k-moves .kind,.k-flicker .kind{background:var(--mark)}
.where{margin:6px 0 2px;color:var(--dim)}
.detail{margin:0 0 10px;font:13px/1.4 ui-monospace,monospace;color:var(--fg);overflow-wrap:anywhere}
.shots{display:grid;gap:10px;grid-template-columns:repeat(2,minmax(0,1fr))}
.shots.n3{grid-template-columns:repeat(3,minmax(0,1fr))}
.shots.n1{grid-template-columns:minmax(0,1fr)}
.shot{margin:0}
.pic{position:relative;border:1px solid var(--line);line-height:0}
.pic img{width:100%;height:auto;display:block}
.pic i{position:absolute;outline:2px solid var(--mark);outline-offset:1px}
.shot figcaption{color:var(--dim);font-size:12px;margin-top:4px}
.none{padding:24px;border:1px dashed var(--line);color:var(--dim)}
.tl{margin:10px 0 0;max-width:340px}
.tl svg{width:100%;height:56px;display:block;border-bottom:1px solid var(--line)}
.tl path{fill:none;stroke:var(--accent);stroke-width:1.5}
.tl-at{stroke:var(--mark);stroke-dasharray:3 3}
.tl figcaption{display:grid;grid-template-columns:auto 1fr auto auto;gap:8px;color:var(--dim);font-size:11px}
.frames{color:var(--dim);font-size:12px;margin:8px 0 0}
.broken{color:var(--dim);font-size:13px;border-top:1px solid var(--line);padding-top:12px}
@media (max-width:640px){.shots,.shots.n3{grid-template-columns:minmax(0,1fr)}}
</style></head>
<body><main>
<h1>${esc(sheet.title)}</h1>
<p class="sum">${found.length === 0 ? "Nothing found" : `${found.length} finding${found.length === 1 ? "" : "s"}`} · ${sheet.screens.length} screens, ${walked} steps · ${sheet.seconds} s · ${esc(sheet.made)}</p>
${cards}
${broken.length === 0 ? "" : `<section class="broken"><h2>Steps that could not run</h2><ul>${broken.map((b) => `<li>${esc(b)}</li>`).join("")}</ul></section>`}
</main></body></html>
`;
}
