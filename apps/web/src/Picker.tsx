// Structure follows T3 Code ModelPickerContent/Sidebar at d137c5081ac5efb2b8ea9aec8b334e1bb4d0182a (MIT).
// The approved local-model adaptation keeps a fixed rail/list/context layout. LICENSES/T3-Code-MIT.txt.
import "./picker.css";
import { type KeyboardEvent, useLayoutEffect, useRef, useState } from "react";
import type { ContextSize, FitTable, ModelInfo } from "@gates-local/contracts";
import { CONTEXT_SIZES, type Verdict, cardGb, ctxFor, gb, k, noGpu, verdictOf } from "./format.ts";
import { markWhole } from "./MemoryMark.tsx";
import { openFit } from "./fit-actions.ts";
import { answers, canPick, cardFit, fitFor, refusedNow, stopsChat } from "./fit-table.ts";
import { MakerMark } from "./MakerMark.tsx";
import { ModelSpeed, speedWords } from "./model-speed.tsx";
import { Icon } from "./icons.tsx";
import { activeEntry, contextRuler, makerGroups, makerOf, pickerEntries, suggestedOf, type Maker } from "./picker-models.ts";
import { focusComposer } from "./Sidebar.tsx";
import { openSettings, pickModel, setContext, updateSettings } from "./session.ts";
import { NA, type State, chatReady, getState, setState, useStore } from "./store.ts";
import { FitSkel, PHONE, closePop, closeTip, esc, isTouch, openTip, tabStops, useMedia } from "./ui.tsx";

const FAVORITES = "gates-local.model-favorites";
/** Below this height the picker's rail, list and context column stop being usable. */
const CRAMPED = 280;
interface Row { tag: string; label: string; name: string; variant: string; info?: ModelInfo; v?: Verdict; downloading?: number; frees: boolean; notNow: boolean }

function savedFavorites(): string[] {
  try {
    const raw: unknown = JSON.parse(localStorage.getItem(FAVORITES) ?? "[]");
    return Array.isArray(raw) ? raw.filter((x): x is string => typeof x === "string") : [];
  } catch { return []; }
}

/** A memory need as shown: an estimate carries a ~, a reading from a real load does not (audit T03). */
const shownNeed = (v: Verdict) => `${v.measured ? "" : "~"}${gb(v.need)}`;

/** Swappable presentation only. The verdict and all byte counts come from the fit table; before the first one, a same-size skeleton. */
export function ContextMemory({ v, cpu, frees = false, ready = true, notNow = false }: { v: Verdict | undefined; cpu: boolean; frees?: boolean; ready?: boolean; notNow?: boolean }) {
  if (!v) return ready ? <span className="pk-cost none">–</span> : <span className="pk-cost"><FitSkel w="104px" /></span>;
  const ruler = contextRuler(v);
  // notNow: the card would hold it, but a send now is refused (fit-table refusedNow); the icon says it, as on the row
  const word = frees ? "Stops chat" : v.k === "no" ? "Too big" : notNow ? "Not now" : cpu ? "System memory" : v.k === "gpu" ? "Fits" : "Slower";
  return <span className={`pk-cost ${notNow && !frees ? "no" : v.k}`} role="img" aria-label={`${gb(v.need)} ${v.measured ? "measured" : "estimated"}; ${word}`}>
    <span className="pk-cost-caption"><span>{shownNeed(v)}</span><small>{notNow && !frees && v.k !== "no" ? <Icon id="xc" /> : null}{word}</small></span>
    {cpu ? null : <span className="pk-cost-track"><i className="pk-cost-room" /><i className="pk-cost-fill" style={{ width: `${ruler.fill}%` }} />{ruler.overflow > 0 ? <i className="pk-cost-over" style={{ width: `${ruler.overflow}%` }} /> : null}<i className="pk-cost-edge" />{ruler.continues ? <b>→</b> : null}</span>}
  </span>;
}

/**
 * The footer's line: the card every size above is judged against ("16 GB GPU"), never what is free
 * this second (decision 12). A placeholder before the first table.
 */
function memoryLine(table: FitTable | undefined, whole: number | undefined) {
  if (!table) return <span aria-busy="true"><FitSkel w="120px" /></span>;
  const m = table.memory;
  return m.kind === "cpu" ? "Runs in system memory" : m.kind === "unreadable" ? "GPU reading unavailable" : whole === undefined ? "" : `${cardGb(whole)} GPU`;
}

/** Keep the picker's context choice for the next start; the chat already runs at it, so a failed save says nothing. */
function saveContext(s: State, size: ContextSize): void {
  const saved = s.settings === NA ? undefined : s.settings?.defaultNumCtx;
  if (saved === undefined || saved === size || s.unavailable["settings.update"] === true) return;
  void updateSettings({ defaultNumCtx: size });
}

export function Picker() {
  const pop = useStore(s => s.pop?.id === "picker" ? s.pop : null);
  const models = useStore(s => s.models);
  const pullNA = useStore(s => s.unavailable["models.pull"] === true);
  const catalogRaw = useStore(s => s.catalog);
  const makers = useStore(s => suggestedOf(s)?.makers);
  const table = useStore(s => s.fitTable);
  // an empty or unreadable table reads as no table: placeholders, and nothing pickable yet
  const answered = answers(table);
  const pulls = useStore(s => s.pulls);
  const numCtx = useStore(s => s.numCtx);
  const selected = useStore(s => s.model);
  const speeds = useStore(s => s.speeds);
  const gpu = useStore(s => s.gpu);
  const whole = useStore(markWhole);
  const settled = useStore(s => s.hydrationSettled), readyForFits = useStore(chatReady);
  const phone = useMedia(PHONE), cpu = table ? table.memory.kind === "cpu" : noGpu(gpu);
  const catalog = catalogRaw === NA ? undefined : catalogRaw;
  const [query, setQuery] = useState("");
  const [group, setGroup] = useState<Maker | "all" | "favorites">("all");
  const [highlight, setHighlight] = useState<string | null>(null);
  const [expanded, setExpanded] = useState(false);
  const [step, setStep] = useState<"models" | "context">("models");
  const [favorites, setFavorites] = useState(savedFavorites);
  const ref = useRef<HTMLDivElement>(null), input = useRef<HTMLInputElement>(null);
  // judged against the card's own memory, as every list is; the send judges right now
  const fitOf = (tag: string, c = numCtx) => cardFit(fitFor(table, tag, ctxFor(c, models, tag)));
  const report = (tag: string, c = numCtx) => {
    const r = fitOf(tag, c);
    return r ? verdictOf(r) : undefined;
  };
  const pickable = (tag: string, c = numCtx) => canPick(fitOf(tag, c));
  // The send's own verdict, right now (the row as it is, not the card's): it cannot run here now.
  const notNow = (tag: string, c = numCtx) => refusedNow(fitFor(table, tag, ctxFor(c, models, tag)));
  // In list order already: filtering keeps it.
  const rows: Row[] = pickerEntries(models, pulls, catalog, selected).map(({ pull, ...entry }) => ({ ...entry, v: report(entry.tag),
    ...pull ? { downloading: pull.totalBytes ? Math.round(pull.completedBytes / pull.totalBytes * 100) : 0, frees: false, notNow: false } : { frees: stopsChat(fitOf(entry.tag)), notNow: notNow(entry.tag) } }));
  const q = query.toLowerCase().trim();
  const filtered = rows.filter(r => q ? `${r.label} ${r.tag}`.toLowerCase().includes(q) : group === "all" || (group === "favorites" ? favorites.includes(r.tag) : makerOf(r.tag, makers) === group));
  const limit = phone ? 5 : 6; // Leave room for Show more alongside the phone's 44 px rows.
  const visible = q || expanded ? filtered : filtered.slice(0, limit);
  const active = activeEntry(visible, selected, highlight);
  const activeMax = active?.info?.maxContext;
  const actual = active ? ctxFor(numCtx, models, active.tag) : numCtx;
  const present = new Set([...rows.map(r => makerOf(r.tag, makers)), ...(catalog ?? []).map(c => makerOf(c.name, makers))]);
  // The first view waits for the model list only; fit values before the first table are skeletons.
  const prepared = !readyForFits || models !== undefined || settled;
  useLayoutEffect(() => {
    if (pop && !pop.ready && prepared && getState().pop === pop) setState({ pop: { ...pop, ready: true } });
  }, [pop, prepared]);
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
    // The note over the box (a refusal and what runs instead) stays in view: opening up, the picker
    // starts above it (WIN-MEM-07).
    const note = document.querySelector('[data-testid="chat.composer.notice"]');
    const top = Math.min(r.top, note?.getBoundingClientRect().top ?? r.top);
    const above = top - 6 - 8, below = window.innerHeight - r.bottom - 6 - 8;
    const up = ph <= above || above >= CRAMPED || above >= below;
    const h = Math.min(ph, up ? above : below);
    if (h < ph) root.style.maxHeight = `${h}px`;
    root.style.left = `${Math.max(8, Math.min(r.right - pw, window.innerWidth - pw - 8))}px`;
    root.style.top = `${up ? top - 6 - h : r.bottom + 6}px`;
  });
  function finish(row: Row, c?: ContextSize) {
    const chosenCtx = c ?? CONTEXT_SIZES.find(n => n === ctxFor(numCtx, models, row.tag)) ?? numCtx;
    // The newest table at click time, not the one this handler was rendered with.
    const now = getState();
    if (row.downloading !== undefined || !canPick(cardFit(fitFor(now.fitTable, row.tag, ctxFor(chosenCtx, now.models, row.tag))))) return;
    closeTip(); setContext(chosenCtx); pickModel(row.tag); closePop();
    // A size chosen here is the only context control (decision 13), so it is also the one the next
    // start begins at. Picking a model alone keeps the saved size: a small model's cap is not a choice.
    if (c !== undefined) saveContext(now, c);
    focusComposer();
  }
  function chooseContext(row: Row, size: ContextSize) {
    if (row.info?.maxContext !== undefined && size > row.info.maxContext) return;
    finish(row, size);
  }
  function choose(row: Row) {
    setHighlight(row.tag);
    if (row.downloading !== undefined) return;
    if (phone) { setStep("context"); requestAnimationFrame(() => ref.current?.querySelector<HTMLButtonElement>(".pk-back")?.focus({ preventScroll: true })); }
    else finish(row);
  }
  function backToModels(search: boolean) {
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
      const i = visible.findIndex(r => r.tag === (highlight ?? selected));
      const index = i < 0 ? (e.key === "ArrowDown" ? 0 : visible.length - 1) : (i + (e.key === "ArrowDown" ? 1 : -1) + visible.length) % visible.length;
      const next = visible[index];
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
  // A row's facts have no hover tooltip (the owner's call): its face shows the size and,
  // by colour, the fit. Screen readers get the size and the fit in words, from the table. Only a cut name has a tip.
  const facts = (row: Row) => {
    const fit = !row.v ? answered ? "No memory reading" : "Checking memory"
      : `${gb(row.v.need)} ${row.v.measured ? "measured" : "estimated"}; ${row.frees ? "sending stops another chat first" : row.notNow ? "not enough memory now" : row.v.k === "no" ? "not enough memory" : cpu ? "runs in system memory" : row.v.k === "gpu" ? "fits on GPU" : `${gb(row.v.amt)} in system memory, slower`}`;
    const speed = speedWords(speeds, row.tag);
    const said = speed === undefined ? fit : `${fit}; ${speed}`;
    return row.downloading === undefined ? said : `Downloading, ${row.downloading}%. ${said}`;
  };
  if (!pop?.ready) return null;
  return <div ref={ref} id="picker" className={`model-picker${pop ? " open" : ""}${step === "context" ? " step-context" : ""}`} role="dialog" aria-label="Choose a model" aria-modal={phone} data-testid="models.picker.dialog" onKeyDown={keys}>
    <div className="pk-layout">
      <nav className="pk-rail" aria-label="Model makers" inert={phone && step === "context"}>
        <button className="pk-fam" data-testid="models.picker.favorites" aria-label="Favorites" aria-pressed={group === "favorites"} data-tip="Favorites" onClick={() => { setGroup("favorites"); setQuery(""); setHighlight(null); setExpanded(false); }}><Icon id="star" /></button>
        <span className="pk-rail-line" />
        <button className="pk-fam" data-testid="models.picker.all" aria-label="All models" aria-pressed={group === "all"} data-tip="All models" onClick={() => { setGroup("all"); setQuery(""); setHighlight(null); setExpanded(false); }}><svg className="mark"><use href="#i-mark" /></svg></button>
        {makerGroups(makers).filter(m => present.has(m)).map(m => <button key={m} className="pk-fam" data-testid="models.picker.maker" aria-label={m} aria-pressed={group === m} data-tip={esc(m)} onClick={() => { setGroup(m); setQuery(""); setHighlight(null); setExpanded(false); input.current?.focus({ preventScroll: true }); }}><MakerMark tag={m === "Phi" ? "phi4" : m} fallbackLabel /></button>)}
      </nav>
      <div className="pk-main">
        <div className="pk-search"><Icon id="search" /><input ref={input} id="pkSearch" role="combobox" placeholder="Search models…" aria-label="Search models" data-testid="models.picker.search" aria-controls="pkList" aria-expanded={!!pop} aria-autocomplete="list" aria-activedescendant={highlight && visible.some(r => r.tag === highlight) ? `pk-opt-${visible.findIndex(r => r.tag === highlight)}` : undefined} value={query} onChange={e => { setQuery(e.target.value); setHighlight(null); closeTip(); }} onKeyDown={modelKeys} /><button className="pk-close" data-testid="models.picker.close" aria-label="Close" onClick={() => closePop(true)}><Icon id="x" /></button></div>
        <div className="pk-list-scroll">
          <div id="pkList" role="listbox" aria-label="Models">
            {/* before the first table every row is busy and cannot be picked yet, with the look it keeps after; once the table is in, a row it cannot pick (no reading, or too big) is disabled, except on the phone, whose context step offers other sizes */}
            {visible.map((r, i) => <div key={r.tag} className={`pk-r${r.tag === selected ? " sel" : ""}${r.tag === highlight ? " hl" : ""}${r.downloading !== undefined || !pickable(r.tag) ? " dis" : ""}`} id={`pk-opt-${i}`} role="option" data-testid="models.picker.option" aria-selected={r.tag === selected} aria-busy={r.downloading === undefined && !answered || undefined} aria-disabled={r.downloading !== undefined || !answered || (!phone && !pickable(r.tag))} data-m={r.tag} data-i={i} onMouseMove={() => setHighlight(r.tag)}>
              {/* a name cut by its row reads in full in a tip, and only then (data-tipt) */}
              <button type="button" className="pk-select" data-testid="models.picker.select" tabIndex={-1} aria-label={r.label} aria-describedby={`pk-facts-${i}`} data-tipt={r.name} onClick={() => choose(r)}><MakerMark tag={r.tag} busy={r.downloading !== undefined} /><span className="pk-name pk-n"><span className="pk-nm">{r.name}</span>{r.variant ? <small className="pk-variant">{r.variant}</small> : null}{r.tag === selected ? <Icon id="check" cls="s12" /> : null}<ModelSpeed tag={r.tag} /></span><span data-testid="models.picker.need" className={`pk-v ${r.notNow ? "no now" : r.v?.k ?? ""}`}>{r.downloading !== undefined ? `${r.downloading}%` : r.v ? <>{r.notNow ? <Icon id="xc" cls="s12" /> : null}{shownNeed(r.v)}</> : answered ? "–" : <FitSkel />}</span></button>
              {/* after the row's name, so the option is announced name first */}
              <span className="vh" id={`pk-facts-${i}`}>{facts(r)}</span>
              <button className="pk-favorite" data-testid="models.picker.favorite" aria-label={`${favorites.includes(r.tag) ? "Unfavorite" : "Favorite"} ${r.label}`} aria-pressed={favorites.includes(r.tag)} onClick={() => toggleFavorite(r.tag)}><Icon id="star" /></button>
            </div>)}
            {visible.length === 0 ? <div className="pk-empty">{models === undefined ? "Couldn't read installed models." : group === "favorites" && !q ? "No favorites yet. Star a model to keep it here." : "No installed model matches."}</div> : null}
          </div>
          <button className="pk-more" data-testid="models.picker.more" disabled={filtered.length <= limit || q !== ""} onClick={() => setExpanded(!expanded)}>{expanded ? "Show less" : "Show more"}</button>
        </div>
      </div>
      <section className="pk-context" aria-label="Context length">
        <header className="pk-context-head"><button className="pk-back" data-testid="models.picker.back" aria-label="Back to models" onClick={e => backToModels(!isTouch() || pop?.kb === true || e.detail === 0)}><Icon id="left" /></button>{/* whose numbers these are, once (WIN-MEM-07): the row the column follows, highlighted or selected; a cut name reads in full in a tip */}<span className="pk-for" data-testid="models.picker.context-for" data-tipt={active?.label}>{active ? <><MakerMark tag={active.tag} /><span className="pk-nm">{active.label}</span></> : null}</span></header>
        <div className="pk-context-rows" role="radiogroup" aria-label={active ? `Context length for ${active.label}` : "Context length"} data-testid="models.picker.context-sizes" onKeyDown={e => {
          if (e.key === "ArrowLeft") { e.preventDefault(); backToModels(true); return; }
          if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
          e.preventDefault(); const buttons = [...e.currentTarget.querySelectorAll<HTMLButtonElement>("button:not(:disabled)")], i = buttons.findIndex(button => button === document.activeElement);
          buttons[(i + (e.key === "ArrowDown" ? 1 : -1) + buttons.length) % buttons.length]?.focus();
        }}>
          {CONTEXT_SIZES.map(c => {
            const v = active ? report(active.tag, c) : undefined, frees = active ? stopsChat(fitOf(active.tag, c)) : false, now = active ? notNow(active.tag, c) : false;
            const capped = activeMax !== undefined && c > activeMax;
            // a size the table has no reading for cannot be picked (finish refuses it), so it says so to assistive tech too;
            // before the table a size is not picked yet either, but stays focusable with its look (native disabled greys it)
            const disabled = !active || active.downloading !== undefined || capped || (answered && !pickable(active.tag, c));
            return <button key={c} className="pk-ctx-row" role="radio" data-testid={`models.picker.context-${c}`} aria-checked={c === actual} aria-disabled={disabled || !answered} aria-busy={(!capped && !answered) || undefined} tabIndex={c === actual ? 0 : -1} data-ctx={c} disabled={disabled} onClick={() => { if (active) chooseContext(active, c); }}><span>{k(c)}</span>{capped ? <small className="pk-cap">Max {k(activeMax)}</small> : <ContextMemory v={v} cpu={cpu} frees={frees} ready={answered} notNow={now} />}<span className="pk-context-check">{c === actual ? <Icon id="check" cls="s12" /> : null}</span></button>;
          })}
        </div>
        {activeMax !== undefined && activeMax < numCtx ? <p className="pk-help">Runs at {k(activeMax)}, the most this model takes.</p> : null}
        {activeMax !== undefined && activeMax < 8192 && active ? <button className="pk-detail" data-testid="models.picker.use-max" disabled={!pickable(active.tag)} onClick={() => finish(active)}>Use at {k(activeMax)}</button> : null}
        {active?.v?.k === "no" ? <button className="pk-detail" data-testid="models.picker.memory-details" onClick={() => { closePop(); openFit(active.tag); }}>Memory details</button> : null}
      </section>
    </div>
    <footer className="pk-bottom">{pullNA ? <span /> : <button data-testid="models.picker.download-models" onClick={() => { closePop(); openSettings("models", true); }}><Icon id="download" />Download models</button>}<span data-testid="models.picker.card">{memoryLine(table, whole)}</span></footer>
  </div>;
}
