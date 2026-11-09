// Structure follows T3 Code ModelPickerContent/Sidebar at d137c5081ac5efb2b8ea9aec8b334e1bb4d0182a (MIT).
// The approved local-model adaptation keeps a fixed rail/list/context layout. LICENSES/T3-Code-MIT.txt.
import { type KeyboardEvent, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { ContextSize, ModelInfo } from "@gates-local/contracts";
import { CONTEXT_SIZES, type Verdict, ctxFor, gb, k, noGpu, verdictOf } from "./format.ts";
import { openFit } from "./fit-actions.ts";
import { MakerMark } from "./MakerMark.tsx";
import { Icon } from "./icons.tsx";
import { chatModels, pendingDownload } from "./pick.ts";
import { contextRuler, makerOf, pickerLabel, pickerLabels, type Maker } from "./picker-models.ts";
import { focusComposer } from "./Sidebar.tsx";
import { currentFit, ensureFit, fitIsCurrent, openSettings, pickModel, setContext } from "./session.ts";
import { NA, fitKey, getState, useStore } from "./store.ts";
import { PHONE, closePop, closeTip, esc, isTouch, place, tabStops, useMedia } from "./ui.tsx";

const MARGIN = 512 * 1024 ** 2; // Display the server's existing VRAM safety margin; never decide fit here.
const FAVORITES = "gates-local.model-favorites";
const makers: readonly Maker[] = ["Gemma", "Qwen", "Milo", "gpt-oss", "Phi", "Mistral", "Other"];
interface Row { tag: string; label: string; name: string; variant: string; info?: ModelInfo; v?: Verdict; downloading?: number; frees: boolean }
interface ContextChoice { tag: string; size: ContextSize }

function savedFavorites(): string[] {
  try {
    const raw: unknown = JSON.parse(localStorage.getItem(FAVORITES) ?? "[]");
    return Array.isArray(raw) ? raw.filter((x): x is string => typeof x === "string") : [];
  } catch { return []; }
}

/** Swappable presentation only. The verdict and all byte counts come from fit.check. */
export function ContextMemory({ v, cpu, frees = false, failed = false }: { v: Verdict | undefined; cpu: boolean; frees?: boolean; failed?: boolean }) {
  if (!v) return <span className="pk-cost pending">{failed ? "Couldn't check" : "Checking…"}</span>;
  const ruler = contextRuler(v);
  const word = frees ? "Stops chat" : v.k === "no" ? "Too big" : cpu ? "System memory" : v.k === "gpu" ? "Fits" : "Slower";
  return <span className={`pk-cost ${v.k}`} role="img" aria-label={`${gb(v.need)} ${v.measured ? "measured" : "estimated"}; ${word}`}>
    <span className="pk-cost-caption"><span>{gb(v.need)}</span><small>{word}</small></span>
    {cpu ? null : <span className="pk-cost-track"><i className="pk-cost-room" /><i className="pk-cost-fill" style={{ width: `${ruler.fill}%` }} />{ruler.overflow > 0 ? <i className="pk-cost-over" style={{ width: `${ruler.overflow}%` }} /> : null}<i className="pk-cost-edge" />{ruler.continues ? <b>→</b> : null}</span>}
  </span>;
}

function contextTip(v: Verdict | undefined, cpu: boolean, frees: boolean): string {
  if (!v) return "Checking memory…";
  const word = frees ? "sending stops another chat first" : v.k === "no" ? "not enough memory" : cpu ? "runs in system memory" : v.k === "gpu" ? "fits on the GPU" : "spills into system memory";
  const room = cpu ? "" : `; ${gb(contextRuler(v).room)} ${v.measured ? "GPU room including this model’s existing allocation; extension is its measured system-memory spill" : "usable after the 512 MiB reserve"}`;
  return `${gb(v.need)} ${v.measured ? "measured" : "estimated"}; ${word}${room}.`;
}

export function Picker() {
  const pop = useStore(s => s.pop?.id === "picker" ? s.pop : null);
  const models = useStore(s => s.models);
  const catalogRaw = useStore(s => s.catalog);
  const fits = useStore(s => s.fits);
  const pulls = useStore(s => s.pulls);
  const stopFrees = useStore(s => s.stopFrees);
  const numCtx = useStore(s => s.numCtx);
  const selected = useStore(s => s.model);
  const gpu = useStore(s => s.gpu);
  const phone = useMedia(PHONE), cpu = noGpu(gpu);
  const catalog = catalogRaw === NA ? undefined : catalogRaw;
  const [query, setQuery] = useState("");
  const [group, setGroup] = useState<Maker | "all" | "favorites">("all");
  const [highlight, setHighlight] = useState<string | null>(null);
  const [expanded, setExpanded] = useState(false);
  const [step, setStep] = useState<"models" | "context">("models");
  const [favorites, setFavorites] = useState(savedFavorites);
  const [choice, setChoice] = useState<ContextChoice | null>(null);
  const ref = useRef<HTMLDivElement>(null), input = useRef<HTMLInputElement>(null);
  // Keep answers across a refresh gap, including a rerender mid-click. An explicit
  // error or newer report replaces the old answer; closing the picker drops this cache.
  const checks = useRef(fits);
  const requested = useRef<ContextChoice | null>(null);
  const refused = useRef<ContextChoice | null>(null);
  const pendingRow = useRef<string | null>(null);
  checks.current = { ...checks.current, ...fits };
  const keyFor = (tag: string, c = numCtx) => fitKey(tag, ctxFor(c, models, tag));
  const checked = (tag: string, c = numCtx) => checks.current[keyFor(tag, c)] ?? catalog?.find(m => m.name === tag && m.fit?.numCtx === ctxFor(c, models, tag))?.fit;
  const stale = (tag: string, c = numCtx) => currentFit(checked(tag, c)) === undefined;
  const report = (tag: string, c = numCtx) => {
    const r = checked(tag, c);
    return r && r !== "error" ? verdictOf(r) : undefined;
  };
  const installed = chatModels(models ?? []);
  const downloading = Object.values(pulls).filter(p => pendingDownload(p, models));
  const labels = pickerLabels([...installed.map(m => m.name), ...downloading.map(p => p.name)], catalog);
  const presentation = (tag: string) => {
    const name = pickerLabel(tag, catalog?.find(c => c.name === tag)?.label), label = labels.get(tag) ?? name;
    return { name, label, variant: label === name ? "" : label.slice(name.length + 3) };
  };
  const rows: Row[] = installed.map(info => ({ tag: info.name, ...presentation(info.name), info, v: report(info.name), frees: stopFrees[keyFor(info.name)] === true }));
  for (const p of downloading) {
    rows.push({ tag: p.name, ...presentation(p.name), v: report(p.name), downloading: p.totalBytes ? Math.round(p.completedBytes / p.totalBytes * 100) : 0, frees: false });
  }
  const q = query.toLowerCase().trim();
  const filtered = rows.filter(r => q ? `${r.label} ${r.tag}`.toLowerCase().includes(q) : group === "all" || (group === "favorites" ? favorites.includes(r.tag) : makerOf(r.tag) === group));
  filtered.sort((a, b) => Number(b.tag === selected) - Number(a.tag === selected) || a.label.localeCompare(b.label, undefined, { numeric: true }));
  const limit = phone ? 5 : 6; // Leave room for Show more alongside the phone's 44 px rows.
  const visible = q || expanded ? filtered : filtered.slice(0, limit);
  const active = (choice ? rows.find(r => r.tag === choice.tag) : undefined) ?? visible.find(r => r.tag === highlight) ?? visible.find(r => r.tag === selected) ?? visible[0];
  const activeMax = active?.info?.maxContext;
  const actual = active ? ctxFor(numCtx, models, active.tag) : numCtx;
  const present = new Set([...rows.map(r => makerOf(r.tag)), ...(catalog ?? []).map(c => makerOf(c.name))]);
  const rowKey = rows.map(r => r.tag).join("\n");
  useEffect(() => {
    if (!pop) return;
    for (const m of chatModels(getState().models ?? [])) ensureFit(m.name, ctxFor(numCtx, models, m.name));
  }, [pop, numCtx, fits, rowKey]);
  useEffect(() => {
    if (!pop || !active) return;
    for (const c of CONTEXT_SIZES) if (activeMax === undefined || c <= activeMax) ensureFit(active.tag, c);
  }, [pop, active?.tag, activeMax, fits]);
  useEffect(() => {
    if (!choice || requested.current !== choice || !pop || getState().pop !== pop) return;
    const row = rows.find(r => r.tag === choice.tag), result = getState().fits[keyFor(choice.tag, choice.size)];
    // An explicit size choice waits for its first answer. Refusals and errors
    // stay visible; a late answer cannot commit a cancelled or replaced choice.
    if (!row || row.downloading !== undefined || (row.info?.maxContext !== undefined && choice.size > row.info.maxContext)) return;
    if (result && result !== "error" && fitIsCurrent(result)) {
      if (result.verdict === "refuse") refused.current = choice;
      else if (refused.current === choice) keepChoice(null);
      else { requested.current = null; finish(row, choice.size); }
    }
  }, [choice, pop, fits, models]);
  useEffect(() => {
    if (!pop || getState().pop !== pop) { pendingRow.current = null; return; }
    const row = rows.find(r => r.tag === pendingRow.current);
    if (!row) { pendingRow.current = null; return; }
    const result = checked(row.tag);
    if (result === "error") { pendingRow.current = null; return; }
    if (!fitIsCurrent(result)) return;
    pendingRow.current = null;
    finish(row);
  }, [fits, models, pop]);
  useLayoutEffect(() => {
    if (!pop) return;
    if (isTouch() && !pop.kb) ref.current?.querySelector<HTMLButtonElement>(".pk-close")?.focus({ preventScroll: true });
    else input.current?.focus({ preventScroll: true });
  }, [pop]);
  useLayoutEffect(() => {
    const root = ref.current, anchor = document.getElementById("modelBtn");
    if (!pop || !root || !anchor) return;
    if (phone) { root.style.left = `${Math.max(8, (window.innerWidth - root.offsetWidth) / 2)}px`; root.style.top = ""; }
    else place(root, anchor, "start");
  });
  function finish(row: Row, c?: ContextSize) {
    if (!fitIsCurrent(checked(row.tag, c))) return;
    const chosenCtx = c ?? CONTEXT_SIZES.find(n => n === ctxFor(numCtx, models, row.tag)) ?? numCtx;
    const key = keyFor(row.tag, chosenCtx), state = getState(), shown = checked(row.tag, chosenCtx), current = state.fits[key];
    // A completed visible check survives a refresh gap; a known refusal at either point wins.
    if (row.downloading !== undefined || !shown || shown === "error" || (shown.verdict === "refuse" && !stopFrees[key])) return;
    if (current === "error" || (current?.verdict === "refuse" && !state.stopFrees[key])) return;
    closeTip(); setContext(chosenCtx); pickModel(row.tag); closePop();
    focusComposer();
  }
  function keepChoice(next: ContextChoice | null) {
    pendingRow.current = null;
    refused.current = null;
    requested.current = next;
    setChoice(next);
  }
  function chooseContext(row: Row, size: ContextSize) {
    if (row.downloading !== undefined || (row.info?.maxContext !== undefined && size > row.info.maxContext)) return;
    keepChoice({ tag: row.tag, size });
    const result = getState().fits[keyFor(row.tag, size)] ?? checked(row.tag, size);
    if (result && result !== "error" && result.verdict !== "refuse" && fitIsCurrent(result)) finish(row, size);
    ensureFit(row.tag, ctxFor(size, models, row.tag));
  }
  function choose(row: Row) {
    keepChoice(null);
    setHighlight(row.tag);
    if (row.downloading !== undefined) return;
    if (phone) { setStep("context"); requestAnimationFrame(() => ref.current?.querySelector<HTMLButtonElement>(".pk-back")?.focus({ preventScroll: true })); }
    else chooseRow(row);
  }
  function chooseRow(row: Row) {
    if (fitIsCurrent(checked(row.tag))) finish(row);
    else { pendingRow.current = row.tag; ensureFit(row.tag, ctxFor(numCtx, models, row.tag)); }
  }
  function backToModels(search: boolean) {
    keepChoice(null);
    setStep("models");
    const focus = () => search ? input.current?.focus({ preventScroll: true }) : ref.current?.querySelector<HTMLButtonElement>(".pk-close")?.focus({ preventScroll: true });
    if (phone) requestAnimationFrame(focus); else focus();
  }
  function toggleFavorite(tag: string) {
    const next = favorites.includes(tag) ? favorites.filter(x => x !== tag) : [...favorites, tag];
    setFavorites(next);
    try { localStorage.setItem(FAVORITES, JSON.stringify(next)); } catch { /* This session still keeps the choice when storage is unavailable. */ }
  }
  function modelKeys(e: KeyboardEvent<HTMLInputElement>) {
    if ((e.ctrlKey || e.metaKey) && /^[1-9]$/.test(e.key)) { e.preventDefault(); const row = visible[Number(e.key) - 1]; if (row) choose(row); return; }
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      keepChoice(null);
      const i = visible.findIndex(r => r.tag === highlight), next = visible[(i + (e.key === "ArrowDown" ? 1 : -1) + visible.length) % visible.length];
      if (next) { setHighlight(next.tag); requestAnimationFrame(() => ref.current?.querySelector(`[data-m="${CSS.escape(next.tag)}"]`)?.scrollIntoView({ block: "nearest" })); }
    } else if (e.key === "Enter" && active) { e.preventDefault(); choose(active); }
    else if (e.key === "ArrowRight" && active && e.currentTarget.selectionStart === query.length) {
      e.preventDefault();
      const focusContext = () => {
        const chosen = ref.current?.querySelector<HTMLButtonElement>(`[data-ctx="${actual}"]:not(:disabled)`);
        (chosen ?? ref.current?.querySelector<HTMLButtonElement>(".pk-ctx-row:not(:disabled)"))?.focus({ preventScroll: true });
      };
      if (phone) { setStep("context"); requestAnimationFrame(focusContext); }
      else focusContext();
    }
  }
  function keys(e: KeyboardEvent<HTMLDivElement>) {
    if (e.key === "Escape") {
      e.preventDefault(); e.stopPropagation(); closePop();
      requestAnimationFrame(() => document.getElementById("modelBtn")?.focus({ preventScroll: true }));
    }
    if (e.key !== "Tab") return;
    const nodes = tabStops(ref.current);
    const first = nodes[0], last = nodes.at(-1);
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last?.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first?.focus(); }
  }
  const free = gpu && gpu !== NA ? gpu.freeBytes : undefined;
  const choiceReport = choice ? checked(choice.tag, choice.size) : undefined;
  const waiting = choice !== null && !fitIsCurrent(choiceReport);
  const choosing = choice !== null && choiceReport !== "error" && choiceReport?.verdict !== "refuse" && active?.tag === choice.tag && (activeMax === undefined || choice.size <= activeMax);
  const choiceMessage = !choice ? null : !rows.some(r => r.tag === choice.tag) ? "This model is no longer installed. Choose another model."
    : activeMax !== undefined && choice.size > activeMax ? `${k(choice.size)} exceeds this model's limit. Choose another size.`
    : choiceReport === "error" ? `Couldn't check ${k(choice.size)}. Your choice is kept while we retry.`
    : refused.current === choice || choiceReport?.verdict === "refuse" ? `${k(choice.size)} needs more memory. Choose another size.`
    : `Choosing ${k(choice.size)}. Checking memory…`;
  const tip = (row: Row) => `<b>${esc(row.label)}</b> · <span class="mono">${esc(row.tag)}</span>${row.info ? `<br>${gb(row.info.sizeBytes)} on disk` : ""}${row.v && !stale(row.tag) ? `<br>${gb(row.v.need)} ${row.v.measured ? "measured" : "estimated"}; ${row.frees ? "sending stops another chat first" : row.v.k === "no" ? "not enough memory" : cpu ? "runs in system memory" : row.v.k === "gpu" ? "fits on GPU" : `${gb(row.v.amt)} in system memory, slower`}` : "<br>Checking memory…"}`;
  return <div ref={ref} id="picker" className={`model-picker${pop ? " open" : ""}${step === "context" ? " step-context" : ""}`} role="dialog" aria-label="Choose a model" aria-modal={phone} aria-busy={choosing || undefined} onKeyDown={keys}>
    <div className="pk-layout">
      <nav className="pk-rail" aria-label="Model makers" inert={phone && step === "context"}>
        <button className="pk-fam" aria-label="Favorites" aria-pressed={group === "favorites"} data-tip="Favorites" onClick={() => { keepChoice(null); setGroup("favorites"); setQuery(""); setHighlight(null); setExpanded(false); }}><Icon id="star" /></button>
        <span className="pk-rail-line" />
        <button className="pk-fam" aria-label="All models" aria-pressed={group === "all"} data-tip="All models" onClick={() => { keepChoice(null); setGroup("all"); setQuery(""); setHighlight(null); setExpanded(false); }}><svg className="mark"><use href="#i-mark" /></svg></button>
        {makers.filter(m => present.has(m)).map(m => <button key={m} className="pk-fam" aria-label={m} aria-pressed={group === m} data-tip={esc(m)} onClick={() => { keepChoice(null); setGroup(m); setQuery(""); setHighlight(null); setExpanded(false); input.current?.focus({ preventScroll: true }); }}><MakerMark tag={m === "Phi" ? "phi4" : m} /></button>)}
      </nav>
      <div className="pk-main">
        <div className="pk-search"><Icon id="search" /><input ref={input} id="pkSearch" role="combobox" placeholder="Search models…" aria-label="Search models" aria-controls="pkList" aria-expanded={!!pop} aria-autocomplete="list" aria-activedescendant={highlight && visible.some(r => r.tag === highlight) ? `pk-opt-${visible.findIndex(r => r.tag === highlight)}` : undefined} value={query} onChange={e => { keepChoice(null); setQuery(e.target.value); setHighlight(null); }} onKeyDown={modelKeys} /><button className="pk-close" aria-label="Close" onClick={() => closePop(true)}><Icon id="x" /></button></div>
        <div className="pk-list-scroll">
          <div id="pkList" role="listbox" aria-label="Models">
            {visible.map((r, i) => <div key={r.tag} className={`pk-r${r.tag === selected ? " sel" : ""}${r.tag === highlight ? " hl" : ""}${r.downloading !== undefined || !fitIsCurrent(checked(r.tag)) || (r.v?.k === "no" && !r.frees) ? " dis" : ""}`} id={`pk-opt-${i}`} role="option" aria-selected={highlight ? r.tag === highlight : r.tag === selected} aria-busy={r.downloading === undefined && !fitIsCurrent(checked(r.tag)) || undefined} aria-disabled={r.downloading !== undefined || (!phone && fitIsCurrent(checked(r.tag)) && r.v?.k === "no" && !r.frees)} data-m={r.tag} data-i={i} data-tip={tip(r)} onMouseMove={() => setHighlight(r.tag)}>
              <button type="button" className="pk-select" tabIndex={-1} aria-label={r.label} onClick={() => choose(r)}><MakerMark tag={r.tag} busy={r.downloading !== undefined} /><span className="pk-name pk-n"><span className="pk-nm">{r.name}</span>{r.variant ? <small className="pk-variant">{r.variant}</small> : null}{r.tag === selected ? <Icon id="check" cls="s12" /> : null}</span><span className={`pk-v ${stale(r.tag) ? "" : r.v?.k ?? ""}`}>{r.downloading !== undefined ? `${r.downloading}%` : r.v ? gb(r.v.need) : checked(r.tag) === "error" ? "Couldn't check" : "Checking…"}</span></button>
              <button className="pk-favorite" aria-label={`${favorites.includes(r.tag) ? "Unfavorite" : "Favorite"} ${r.label}`} aria-pressed={favorites.includes(r.tag)} onClick={() => toggleFavorite(r.tag)}><Icon id="star" /></button>
            </div>)}
            {visible.length === 0 ? <div className="pk-empty">{group === "favorites" && !q ? "No favorites yet. Star a model to keep it here." : "No installed model matches."}</div> : null}
          </div>
          <button className="pk-more" disabled={filtered.length <= limit || q !== ""} onClick={() => setExpanded(!expanded)}>{expanded ? "Show less" : "Show more"}</button>
        </div>
      </div>
      <section className="pk-context" aria-label="Context length">
        <header className="pk-context-head"><button className="pk-back" aria-label="Back to models" onClick={e => backToModels(!isTouch() || pop?.kb === true || e.detail === 0)}><Icon id="left" /></button><span>Context length</span><small data-tip={active ? esc(active.label) : undefined}>{active?.label}</small></header>
        <div className="pk-context-rows" role="radiogroup" aria-label="Context length" onKeyDown={e => {
          if (e.key === "ArrowLeft") { e.preventDefault(); backToModels(true); return; }
          if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
          e.preventDefault(); const buttons = [...e.currentTarget.querySelectorAll<HTMLButtonElement>("button:not(:disabled)")], i = buttons.findIndex(button => button === document.activeElement);
          buttons[(i + (e.key === "ArrowDown" ? 1 : -1) + buttons.length) % buttons.length]?.focus();
        }}>
          {CONTEXT_SIZES.map(c => {
            const v = active && !stale(active.tag, c) ? report(active.tag, c) : undefined, frees = active ? stopFrees[keyFor(active.tag, c)] === true : false;
            const capped = activeMax !== undefined && c > activeMax;
            const disabled = !active || active.downloading !== undefined || capped || (v?.k === "no" && !frees);
            return <button key={c} className="pk-ctx-row" role="radio" aria-checked={c === actual} aria-disabled={disabled} aria-busy={choice?.size === c && waiting || undefined} tabIndex={c === actual ? 0 : -1} data-ctx={c} disabled={disabled} data-tip={capped ? `This model takes up to ${k(activeMax)}.` : contextTip(v, cpu, frees)} onClick={() => { if (active) chooseContext(active, c); }}><span>{k(c)}</span>{capped ? <small className="pk-cap">Max {k(activeMax)}</small> : <ContextMemory v={v} cpu={cpu} frees={frees} failed={active !== undefined && checked(active.tag, c) === "error"} />}<span className="pk-context-check">{c === actual ? <Icon id="check" cls="s12" /> : null}</span></button>;
          })}
        </div>
        {choiceMessage ? <p className="pk-help pk-choice" role="status">{choiceMessage}</p> : null}
        {!choiceMessage && activeMax !== undefined && activeMax < numCtx ? <p className="pk-help">Runs at {k(activeMax)}, the most this model takes.</p> : null}
        {activeMax !== undefined && activeMax < 8192 && active ? <button className="pk-detail" disabled={fitIsCurrent(checked(active.tag)) && active.v?.k === "no" && !active.frees} onClick={() => { keepChoice(null); chooseRow(active); }}>Use at {k(activeMax)}</button> : null}
        {active?.v?.k === "no" ? <button className="pk-detail" onClick={() => { closePop(); openFit(active.tag); }}>Memory details</button> : null}
      </section>
    </div>
    <footer className="pk-bottom"><button onClick={() => { closePop(); openSettings("models", true); }}><Icon id="download" />Download models</button><span>{cpu ? "Runs in system memory" : free === undefined ? "Checking memory…" : `${gb(free)} free · ${gb(Math.max(0, free - MARGIN))} usable`}</span></footer>
  </div>;
}
