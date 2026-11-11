// Structure follows T3 Code ModelPickerContent/Sidebar at d137c5081ac5efb2b8ea9aec8b334e1bb4d0182a (MIT).
// The approved local-model adaptation keeps a fixed rail/list/context layout. LICENSES/T3-Code-MIT.txt.
import "./picker.css";
import { type KeyboardEvent, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { ContextSize, ModelInfo } from "@gates-local/contracts";
import { CONTEXT_SIZES, type Verdict, ctxFor, gb, k, noGpu, verdictOf } from "./format.ts";
import { openFit } from "./fit-actions.ts";
import { displayFit } from "./fit-display.ts";
import { MakerMark } from "./MakerMark.tsx";
import { Icon } from "./icons.tsx";
import { chatModels } from "./pick.ts";
import { activeEntry, contextRuler, makerOf, pickerEntries, type Maker } from "./picker-models.ts";
import { focusComposer } from "./Sidebar.tsx";
import { ensureFit, fitIsCurrent, openSettings, pickModel, setContext } from "./session.ts";
import { NA, chatReady, fitKey, getState, setState, useStore } from "./store.ts";
import { PHONE, closePop, closeTip, esc, isTouch, openTip, tabStops, useMedia } from "./ui.tsx";

const MARGIN = 512 * 1024 ** 2; // Display the server's existing VRAM safety margin; never decide fit here.
const FAVORITES = "gates-local.model-favorites";
/** Below this height the picker's rail, list and context column stop being usable. */
const CRAMPED = 280;
const PREPARE_TIMEOUT_MS = 30_000;
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
export function ContextMemory({ v, cpu, frees = false, failed = false, history = false }: { v: Verdict | undefined; cpu: boolean; frees?: boolean; failed?: boolean; history?: boolean }) {
  if (!v) return <span className="pk-cost pending">{failed ? "Couldn't check" : "Checking…"}</span>;
  const ruler = contextRuler(v);
  const word = history ? "Previous check" : frees ? "Stops chat" : v.k === "no" ? "Too big" : cpu ? "System memory" : v.k === "gpu" ? "Fits" : "Slower";
  return <span className={`pk-cost ${history ? "history" : v.k}`} role="img" aria-label={`${gb(v.need)} ${v.measured ? "measured" : "estimated"}; ${word}`}>
    <span className="pk-cost-caption"><span>{gb(v.need)}</span><small>{word}</small></span>
    {cpu ? null : <span className="pk-cost-track"><i className="pk-cost-room" /><i className="pk-cost-fill" style={{ width: `${ruler.fill}%` }} />{ruler.overflow > 0 ? <i className="pk-cost-over" style={{ width: `${ruler.overflow}%` }} /> : null}<i className="pk-cost-edge" />{ruler.continues ? <b>→</b> : null}</span>}
  </span>;
}

export function Picker() {
  const pop = useStore(s => s.pop?.id === "picker" ? s.pop : null);
  const models = useStore(s => s.models);
  const pullNA = useStore(s => s.unavailable["models.pull"] === true);
  const catalogRaw = useStore(s => s.catalog);
  const fits = useStore(s => s.fits);
  const loads = useStore(s => s.loads);
  const pulls = useStore(s => s.pulls);
  const stopFrees = useStore(s => s.stopFrees);
  const numCtx = useStore(s => s.numCtx);
  const selected = useStore(s => s.model);
  const gpu = useStore(s => s.gpu);
  const settled = useStore(s => s.hydrationSettled), readyForFits = useStore(chatReady);
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
  const stale = (tag: string, c = numCtx) => !fitIsCurrent(checked(tag, c));
  const report = (tag: string, c = numCtx) => {
    const ctx = ctxFor(c, models, tag);
    const load = loads?.[tag];
    const previous = catalog?.find(m => m.name === tag)?.fit;
    const r = displayFit(keyFor(tag, c), checked(tag, c), load?.state === "loading" && load.numCtx === ctx, previous?.numCtx === ctx ? previous : undefined);
    return r ? verdictOf(r) : undefined;
  };
  const installed = chatModels(models ?? []);
  // In list order already: filtering keeps it, and intent warming reads the same entries.
  const rows: Row[] = pickerEntries(models, pulls, catalog, selected).map(({ pull, ...entry }) => ({ ...entry, v: report(entry.tag),
    ...pull ? { downloading: pull.totalBytes ? Math.round(pull.completedBytes / pull.totalBytes * 100) : 0, frees: false } : { frees: stopFrees[keyFor(entry.tag)] === true } }));
  const q = query.toLowerCase().trim();
  const filtered = rows.filter(r => q ? `${r.label} ${r.tag}`.toLowerCase().includes(q) : group === "all" || (group === "favorites" ? favorites.includes(r.tag) : makerOf(r.tag) === group));
  const limit = phone ? 5 : 6; // Leave room for Show more alongside the phone's 44 px rows.
  const visible = q || expanded ? filtered : filtered.slice(0, limit);
  const active = activeEntry(visible, selected, highlight, choice ? rows.find(r => r.tag === choice.tag) : undefined);
  const activeMax = active?.info?.maxContext;
  const actual = active ? ctxFor(numCtx, models, active.tag) : numCtx;
  const present = new Set([...rows.map(r => makerOf(r.tag)), ...(catalog ?? []).map(c => makerOf(c.name))]);
  const rowKey = rows.map(r => r.tag).toSorted().join("\n");
  const answered = (tag: string, c = numCtx) => { const r = checked(tag, c); return r === "error" || fitIsCurrent(r); };
  // First opening needs current answers; explicit errors also settle a check.
  // Later refreshes keep readable history on screen; opening never authorizes a pick.
  const prepared = !readyForFits || (models !== undefined || settled) && (gpu !== undefined || settled) &&
    installed.every(m => answered(m.name)) &&
    (!active || CONTEXT_SIZES.every(c => activeMax !== undefined && c > activeMax || answered(active.tag, c)));
  useLayoutEffect(() => {
    if (pop && !pop.ready && prepared && getState().pop === pop) setState({ pop: { ...pop, ready: true } });
  }, [pop, prepared]);
  useLayoutEffect(() => {
    if (!pop || pop.ready || getState().pop !== pop) return;
    // Bound this opening, not an epoch: repeated invalidations may discard
    // every request's timeout. Retained rows already mark stale answers busy.
    const timer = setTimeout(() => {
      if (getState().pop === pop) setState({ pop: { ...pop, ready: true } });
    }, PREPARE_TIMEOUT_MS);
    return () => clearTimeout(timer);
  }, [pop]);
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
    if (!pop?.ready) return;
    if (isTouch() && !pop.kb) ref.current?.querySelector<HTMLButtonElement>(".pk-close")?.focus({ preventScroll: true });
    else input.current?.focus({ preventScroll: true });
  }, [pop]);
  useLayoutEffect(() => {
    const root = ref.current, anchor = document.getElementById("modelBtn");
    if (!pop || !root || !anchor) return;
    root.style.maxHeight = "";
    if (phone) { root.style.left = `${Math.max(8, (window.innerWidth - root.offsetWidth) / 2)}px`; root.style.top = ""; return; }
    // A popover over the conversation: its right edge on the button's right
    // edge, growing left and up from just above the button, over the composer
    // and the text above it. `place` would lift it clear of the whole composer.
    // On the empty new-thread screen the composer sits mid-window: the picker
    // gives up a little height (its list scrolls) rather than cover the button,
    // and opens below only when even that leaves it cramped.
    const r = anchor.getBoundingClientRect(), pw = root.offsetWidth, ph = root.offsetHeight;
    const above = r.top - 6 - 8, below = window.innerHeight - r.bottom - 6 - 8;
    const up = ph <= above || above >= CRAMPED || above >= below;
    const h = Math.min(ph, up ? above : below);
    if (h < ph) root.style.maxHeight = `${h}px`;
    root.style.left = `${Math.max(8, Math.min(r.right - pw, window.innerWidth - pw - 8))}px`;
    root.style.top = `${up ? r.top - 6 - h : r.bottom + 6}px`;
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
      if (next) {
        setHighlight(next.tag);
        requestAnimationFrame(() => {
          const row = ref.current?.querySelector(`[data-m="${CSS.escape(next.tag)}"]`);
          row?.scrollIntoView({ block: "nearest" });
          // focus stays in the search field: the highlighted row's cut name opens its tip as focus would
          openTip(row?.querySelector(".pk-select"));
        });
      }
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
  // A row's facts have no hover tooltip (the owner's call): its face shows the size and,
  // by colour, the fit. Screen readers get the size and the fit in words. Only a cut name has a tip.
  const facts = (row: Row) => {
    const fit = !row.v ? checked(row.tag) === "error" ? "Couldn't check memory" : "Checking memory"
      : stale(row.tag) ? `${gb(row.v.need)} previous check; checking again`
      : `${gb(row.v.need)} ${row.v.measured ? "measured" : "estimated"}; ${row.frees ? "sending stops another chat first" : row.v.k === "no" ? "not enough memory" : cpu ? "runs in system memory" : row.v.k === "gpu" ? "fits on GPU" : `${gb(row.v.amt)} in system memory, slower`}`;
    return row.downloading === undefined ? fit : `Downloading, ${row.downloading}%. ${fit}`;
  };
  if (!pop?.ready) return null;
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
            {visible.map((r, i) => <div key={r.tag} className={`pk-r${r.tag === selected ? " sel" : ""}${r.tag === highlight ? " hl" : ""}${r.downloading !== undefined || !fitIsCurrent(checked(r.tag)) || (r.v?.k === "no" && !r.frees) ? " dis" : ""}`} id={`pk-opt-${i}`} role="option" aria-selected={highlight ? r.tag === highlight : r.tag === selected} aria-busy={r.downloading === undefined && !fitIsCurrent(checked(r.tag)) || undefined} aria-disabled={r.downloading !== undefined || (!phone && fitIsCurrent(checked(r.tag)) && r.v?.k === "no" && !r.frees)} data-m={r.tag} data-i={i} onMouseMove={() => setHighlight(r.tag)}>
              {/* a name cut by its row reads in full in a tip, and only then (data-tipt) */}
              <button type="button" className="pk-select" tabIndex={-1} aria-label={r.label} aria-describedby={`pk-facts-${i}`} data-tipt={r.name} onClick={() => choose(r)}><MakerMark tag={r.tag} busy={r.downloading !== undefined} /><span className="pk-name pk-n"><span className="pk-nm">{r.name}</span>{r.variant ? <small className="pk-variant">{r.variant}</small> : null}{r.tag === selected ? <Icon id="check" cls="s12" /> : null}</span><span className={`pk-v ${stale(r.tag) ? "" : r.v?.k ?? ""}`}>{r.downloading !== undefined ? `${r.downloading}%` : r.v ? gb(r.v.need) : checked(r.tag) === "error" ? "Couldn't check" : "Checking…"}</span></button>
              {/* after the row's name, so the option is announced name first */}
              <span className="vh" id={`pk-facts-${i}`}>{facts(r)}</span>
              <button className="pk-favorite" aria-label={`${favorites.includes(r.tag) ? "Unfavorite" : "Favorite"} ${r.label}`} aria-pressed={favorites.includes(r.tag)} onClick={() => toggleFavorite(r.tag)}><Icon id="star" /></button>
            </div>)}
            {visible.length === 0 ? <div className="pk-empty">{models === undefined ? "Couldn't read installed models." : group === "favorites" && !q ? "No favorites yet. Star a model to keep it here." : "No installed model matches."}</div> : null}
          </div>
          <button className="pk-more" disabled={filtered.length <= limit || q !== ""} onClick={() => setExpanded(!expanded)}>{expanded ? "Show less" : "Show more"}</button>
        </div>
      </div>
      <section className="pk-context" aria-label="Context length">
        <header className="pk-context-head"><button className="pk-back" aria-label="Back to models" onClick={e => backToModels(!isTouch() || pop?.kb === true || e.detail === 0)}><Icon id="left" /></button><span>Context length</span>{/* the wide picker shows the model list beside it; the phone's context screen does not */}{phone ? <small data-tip={active ? esc(active.label) : undefined}>{active?.label}</small> : null}</header>
        <div className="pk-context-rows" role="radiogroup" aria-label={active ? `Context length for ${active.label}` : "Context length"} onKeyDown={e => {
          if (e.key === "ArrowLeft") { e.preventDefault(); backToModels(true); return; }
          if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
          e.preventDefault(); const buttons = [...e.currentTarget.querySelectorAll<HTMLButtonElement>("button:not(:disabled)")], i = buttons.findIndex(button => button === document.activeElement);
          buttons[(i + (e.key === "ArrowDown" ? 1 : -1) + buttons.length) % buttons.length]?.focus();
        }}>
          {CONTEXT_SIZES.map(c => {
            const v = active ? report(active.tag, c) : undefined, history = active ? stale(active.tag, c) : false, frees = active ? stopFrees[keyFor(active.tag, c)] === true : false;
            const capped = activeMax !== undefined && c > activeMax;
            const disabled = !active || active.downloading !== undefined || capped || (!history && v?.k === "no" && !frees);
            return <button key={c} className="pk-ctx-row" role="radio" aria-checked={c === actual} aria-disabled={disabled} aria-busy={history || choice?.size === c && waiting || undefined} tabIndex={c === actual ? 0 : -1} data-ctx={c} disabled={disabled} onClick={() => { if (active) chooseContext(active, c); }}><span>{k(c)}</span>{capped ? <small className="pk-cap">Max {k(activeMax)}</small> : <ContextMemory v={v} cpu={cpu} frees={frees} history={history} failed={active !== undefined && checked(active.tag, c) === "error"} />}<span className="pk-context-check">{c === actual ? <Icon id="check" cls="s12" /> : null}</span></button>;
          })}
        </div>
        {choiceMessage ? <p className="pk-help pk-choice" role="status">{choiceMessage}</p> : null}
        {!choiceMessage && activeMax !== undefined && activeMax < numCtx ? <p className="pk-help">Runs at {k(activeMax)}, the most this model takes.</p> : null}
        {activeMax !== undefined && activeMax < 8192 && active ? <button className="pk-detail" disabled={fitIsCurrent(checked(active.tag)) && active.v?.k === "no" && !active.frees} onClick={() => { keepChoice(null); chooseRow(active); }}>Use at {k(activeMax)}</button> : null}
        {active?.v?.k === "no" ? <button className="pk-detail" onClick={() => { closePop(); openFit(active.tag); }}>Memory details</button> : null}
      </section>
    </div>
    <footer className="pk-bottom">{pullNA ? <span /> : <button onClick={() => { closePop(); openSettings("models", true); }}><Icon id="download" />Download models</button>}<span>{cpu ? "Runs in system memory" : free === undefined ? "GPU reading unavailable" : `${gb(free)} free · ${gb(Math.max(0, free - MARGIN))} usable`}</span></footer>
  </div>;
}
