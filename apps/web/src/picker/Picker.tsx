// Structure follows T3 Code ModelPickerContent/Sidebar at d137c5081ac5efb2b8ea9aec8b334e1bb4d0182a (MIT).
// The approved local-model adaptation keeps a fixed rail/list/context layout. LICENSES/T3-Code-MIT.txt.
import "./picker.css";
import { type KeyboardEvent, useRef, useState } from "react";
import type { ContextSize, FitTable, ModelInfo } from "@gates-local/contracts";
import { CONTEXT_SIZES, type SlowReason, type Verdict, ctxFor, gb, k, noGpu, slowReason, verdictOf } from "../lib/words/format.ts";
import { markWhole } from "../models/MemoryMark.tsx";
import { openFit } from "../fit/fit-actions.ts";
import { answers, canPick, cardFit, cardLine, fitFor, refusedNow, stopsChat } from "../fit/fit-table.ts";
import { MakerMark } from "../models/MakerMark.tsx";
import { ModelSpeed, speedWords } from "../models/model-speed.tsx";
import { Icon } from "../lib/ui/icons.tsx";
import { afterCommit, requestFocus } from "../lib/ui/kit/focus.ts";
import { usePopover } from "../lib/ui/kit/popover.ts";
import { pickerEntry } from "./picker-entry.ts";
import { activeEntry, contextRuler, makerGroups, makerOf, pickerEntries, suggestedOf, type Maker } from "./picker-models.ts";
import { focusComposer } from "../composer/focus.ts";
import { openSettings, pickModel, setContext, updateSettings } from "../lib/session/index.ts";
import { NA, type State, getState, useStore } from "../lib/store/store.ts";
import { FitSkel, PHONE, closePop, closeTip, esc, isTouch, openTip, tabStops, useMedia } from "../lib/ui/ui.tsx";

const FAVORITES = "gates-local.model-favorites";
const CRAMPED = 280;
interface Row { tag: string; label: string; name: string; variant: string; info?: ModelInfo; v?: Verdict; downloading?: number; frees: boolean; notNow: boolean; slow?: SlowReason | undefined }

function savedFavorites(): string[] {
  try {
    const raw: unknown = JSON.parse(localStorage.getItem(FAVORITES) ?? "[]");
    return Array.isArray(raw) ? raw.filter((x): x is string => typeof x === "string") : [];
  } catch { return []; }
}

const shownNeed = (v: Verdict) => `${v.measured ? "" : "~"}${gb(v.need)}`;
const SlowMark = () => <span style={{ display: "inline-flex", color: "var(--amber-fg)" }}><Icon id="gauge" cls="s12" /></span>;

export function ContextMemory({ v, cpu, frees = false, ready = true, notNow = false, slow }: { v: Verdict | undefined; cpu: boolean; frees?: boolean; ready?: boolean; notNow?: boolean; slow?: SlowReason | undefined }) {
  if (!v) return ready ? <span className="pk-cost none">–</span> : <span className="pk-cost"><FitSkel w="104px" /></span>;
  const ruler = contextRuler(v);
  const slowNow = slow !== undefined && !frees && !notNow && !cpu && v.k === "gpu";
  const word = v.short;
  return <span className={`pk-cost ${notNow && !frees ? "no" : v.k}`} role="img" aria-label={`${gb(v.need)} ${v.measured ? "measured" : "estimated"}; ${word}${slowNow ? `; slower now. ${slow.sentence}` : ""}`} {...slowNow ? { "data-tip": esc(slow.short), "data-testid": "models.picker.slow-now" } : {}}>
    <span className="pk-cost-caption"><span>{shownNeed(v)}</span><small>{notNow && !frees && v.k !== "no" ? <Icon id="xc" /> : null}{slowNow ? <SlowMark /> : null}{word}</small></span>
    {cpu ? null : <span className="pk-cost-track"><i className="pk-cost-room" /><i className="pk-cost-fill" style={{ width: `${ruler.fill}%` }} />{ruler.overflow > 0 ? <i className="pk-cost-over" style={{ width: `${ruler.overflow}%` }} /> : null}<i className="pk-cost-edge" />{ruler.continues ? <b>→</b> : null}</span>}
  </span>;
}

function memoryLine(table: FitTable | undefined, whole: number | undefined) {
  if (!table) return <span aria-busy="true"><FitSkel w="120px" /></span>;
  return cardLine(table.memory, whole);
}

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
  const answered = answers(table);
  const pulls = useStore(s => s.pulls);
  const numCtx = useStore(s => s.numCtx);
  const selected = useStore(s => s.model);
  const speeds = useStore(s => s.speeds);
  const gpu = useStore(s => s.gpu);
  const whole = useStore(markWhole);
  const phone = useMedia(PHONE), cpu = table ? table.memory.kind === "cpu" : noGpu(gpu);
  const catalog = catalogRaw === NA ? undefined : catalogRaw;
  const [query, setQuery] = useState("");
  const [group, setGroup] = useState<Maker | "all" | "favorites">("all");
  const [highlight, setHighlight] = useState<string | null>(null);
  const [expanded, setExpanded] = useState(false);
  const [step, setStep] = useState<"models" | "context">("models");
  const [favorites, setFavorites] = useState(savedFavorites);
  const ref = useRef<HTMLDivElement>(null), input = useRef<HTMLInputElement>(null);
  const fitOf = (tag: string, c = numCtx) => cardFit(fitFor(table, tag, ctxFor(c, models, tag)));
  const report = (tag: string, c = numCtx) => {
    const r = fitOf(tag, c);
    return r ? verdictOf(r) : undefined;
  };
  const pickable = (tag: string, c = numCtx) => canPick(fitOf(tag, c));
  const notNow = (tag: string, c = numCtx) => refusedNow(fitFor(table, tag, ctxFor(c, models, tag)));
  const rows: Row[] = pickerEntries(models, pulls, catalog, selected).map(({ pull, ...entry }) => ({ ...entry, v: report(entry.tag),
    ...pull ? { downloading: pull.totalBytes ? Math.round(pull.completedBytes / pull.totalBytes * 100) : 0, frees: false, notNow: false } : { frees: stopsChat(fitOf(entry.tag)), notNow: notNow(entry.tag), slow: slowReason(fitOf(entry.tag)?.slowNow) } }));
  const q = query.toLowerCase().trim();
  const filtered = rows.filter(r => q ? `${r.label} ${r.tag}`.toLowerCase().includes(q) : group === "all" || (group === "favorites" ? favorites.includes(r.tag) : makerOf(r.tag, makers) === group));
  const limit = phone ? 5 : 6;
  const visible = q || expanded ? filtered : filtered.slice(0, limit);
  const active = activeEntry(visible, selected, highlight);
  const activeMax = active?.info?.maxContext;
  const actual = active ? ctxFor(numCtx, models, active.tag) : numCtx;
  const present = new Set([...rows.map(r => makerOf(r.tag, makers)), ...(catalog ?? []).map(c => makerOf(c.name, makers))]);
  // why: the root draws only once the model list is in, and focus goes in as it does
  const [entry] = useState(() => pickerEntry(ref, () => input.current));
  usePopover(ref, pop !== null, (root) => {
    const anchor = document.getElementById("modelBtn");
    if (!anchor) return;
    root.style.maxHeight = "";
    if (phone) { root.style.left = `${Math.max(8, (window.innerWidth - root.offsetWidth) / 2)}px`; root.style.top = ""; return; }
    const r = anchor.getBoundingClientRect(), pw = root.offsetWidth, ph = root.offsetHeight;
    const note = document.querySelector('[data-testid="chat.composer.offer"], [data-testid="chat.composer.notice"]');
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
    const now = getState();
    if (row.downloading !== undefined || !canPick(cardFit(fitFor(now.fitTable, row.tag, ctxFor(chosenCtx, now.models, row.tag))))) return;
    closeTip(); setContext(chosenCtx); pickModel(row.tag); closePop();
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
    if (phone) { setStep("context"); requestFocus(() => ref.current?.querySelector<HTMLButtonElement>(".pk-back"), { preventScroll: true }); }
    else finish(row);
  }
  function backToModels(search: boolean) {
    setStep("models");
    const target = () => search ? input.current : ref.current?.querySelector<HTMLButtonElement>(".pk-close");
    if (phone) requestFocus(target, { preventScroll: true }); else target()?.focus({ preventScroll: true });
  }
  function toggleFavorite(tag: string) {
    const next = favorites.includes(tag) ? favorites.filter(x => x !== tag) : [...favorites, tag];
    setFavorites(next);
    try { localStorage.setItem(FAVORITES, JSON.stringify(next)); } catch {}
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
        afterCommit(() => {
          const row = ref.current?.querySelector(`[data-m="${CSS.escape(next.tag)}"]`);
          row?.scrollIntoView({ block: "nearest" });
          openTip(row?.querySelector(".pk-select"));
        });
      }
    } else if (e.key === "Enter" && active) { e.preventDefault(); choose(active); }
    else if (e.key === "ArrowRight" && active && e.currentTarget.selectionStart === query.length) {
      e.preventDefault();
      const context = () => ref.current?.querySelector<HTMLButtonElement>(`[data-ctx="${actual}"]:not(:disabled)`) ?? ref.current?.querySelector<HTMLButtonElement>(".pk-ctx-row:not(:disabled)");
      if (phone) { setStep("context"); requestFocus(context, { preventScroll: true }); }
      else context()?.focus({ preventScroll: true });
    }
  }
  function keys(e: KeyboardEvent<HTMLDivElement>) {
    if (e.key === "Escape") {
      e.preventDefault(); e.stopPropagation(); closePop();
      requestFocus("#modelBtn", { preventScroll: true });
    }
    if (e.key !== "Tab") return;
    const nodes = tabStops(ref.current);
    const first = nodes[0], last = nodes.at(-1);
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last?.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first?.focus(); }
  }
  const facts = (row: Row) => {
    const fit = !row.v ? answered ? "No memory reading" : "Checking memory"
      : `${gb(row.v.need)} ${row.v.measured ? "measured" : "estimated"}; ${row.frees ? "sending stops another chat first" : row.notNow ? "not enough memory now" : row.v.k === "no" ? "not enough memory" : cpu ? "runs in system memory" : row.v.k === "gpu" ? row.slow ? `fits on GPU; slower now. ${row.slow.sentence}` : "fits on GPU" : `${gb(row.v.amt)} in system memory, slower`}`;
    const speed = speedWords(speeds, row.tag);
    const said = speed === undefined ? fit : `${fit}; ${speed}`;
    return row.downloading === undefined ? said : `Downloading, ${row.downloading}%. ${said}`;
  };
  if (!pop?.ready) return null;
  return <div ref={entry} id="picker" className={`model-picker${pop ? " open" : ""}${step === "context" ? " step-context" : ""}`} role="dialog" aria-label="Choose a model" aria-modal={phone} data-testid="models.picker.dialog" onKeyDown={keys}>
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
            {visible.map((r, i) => <div key={r.tag} className={`pk-r${r.tag === selected ? " sel" : ""}${r.tag === highlight ? " hl" : ""}${r.downloading !== undefined || !pickable(r.tag) ? " dis" : ""}`} id={`pk-opt-${i}`} role="option" data-testid="models.picker.option" aria-selected={r.tag === selected} aria-busy={r.downloading === undefined && !answered || undefined} aria-disabled={r.downloading !== undefined || !answered || (!phone && !pickable(r.tag))} data-m={r.tag} data-i={i} onMouseMove={() => setHighlight(r.tag)}>
              <button type="button" className="pk-select" data-testid="models.picker.select" tabIndex={-1} aria-label={r.label} aria-describedby={`pk-facts-${i}`} data-tipt={r.name} onClick={() => choose(r)}><MakerMark tag={r.tag} busy={r.downloading !== undefined} /><span className="pk-name pk-n"><span className="pk-nm">{r.name}</span>{r.variant ? <small className="pk-variant">{r.variant}</small> : null}{r.tag === selected ? <Icon id="check" cls="s12" /> : null}<ModelSpeed tag={r.tag} /></span><span data-testid="models.picker.need" className={`pk-v ${r.notNow ? "no now" : r.v?.k ?? ""}`}>{r.downloading !== undefined ? `${r.downloading}%` : r.v ? <>{r.notNow ? <Icon id="xc" cls="s12" /> : null}{shownNeed(r.v)}</> : answered ? "–" : <FitSkel />}</span></button>
              <span className="vh" id={`pk-facts-${i}`}>{facts(r)}</span>
              <button className="pk-favorite" data-testid="models.picker.favorite" aria-label={`${favorites.includes(r.tag) ? "Unfavorite" : "Favorite"} ${r.label}`} aria-pressed={favorites.includes(r.tag)} onClick={() => toggleFavorite(r.tag)}><Icon id="star" /></button>
            </div>)}
            {visible.length === 0 ? <div className="pk-empty">{models === undefined ? "Couldn't read installed models." : group === "favorites" && !q ? "No favorites yet. Star a model to keep it here." : "No installed model matches."}</div> : null}
          </div>
          <button className="pk-more" data-testid="models.picker.more" disabled={filtered.length <= limit || q !== ""} onClick={() => setExpanded(!expanded)}>{expanded ? "Show less" : "Show more"}</button>
        </div>
      </div>
      <section className="pk-context" aria-label="Context length">
        <header className="pk-context-head"><button className="pk-back" data-testid="models.picker.back" aria-label="Back to models" onClick={e => backToModels(!isTouch() || pop?.kb === true || e.detail === 0)}><Icon id="left" /></button><span className="pk-for" data-testid="models.picker.context-for" data-tipt={active?.label}>{active ? <><MakerMark tag={active.tag} /><span className="pk-nm">{active.label}</span></> : null}</span></header>
        <div className="pk-context-rows" role="radiogroup" aria-label={active ? `Context length for ${active.label}` : "Context length"} data-testid="models.picker.context-sizes" onKeyDown={e => {
          if (e.key === "ArrowLeft") { e.preventDefault(); backToModels(true); return; }
          if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
          e.preventDefault(); const buttons = [...e.currentTarget.querySelectorAll<HTMLButtonElement>("button:not(:disabled)")], i = buttons.findIndex(button => button === document.activeElement);
          buttons[(i + (e.key === "ArrowDown" ? 1 : -1) + buttons.length) % buttons.length]?.focus();
        }}>
          {CONTEXT_SIZES.map(c => {
            const v = active ? report(active.tag, c) : undefined, frees = active ? stopsChat(fitOf(active.tag, c)) : false, now = active ? notNow(active.tag, c) : false, slow = active ? slowReason(fitOf(active.tag, c)?.slowNow) : undefined;
            const capped = activeMax !== undefined && c > activeMax;
            const disabled = !active || active.downloading !== undefined || capped || (answered && !pickable(active.tag, c));
            return <button key={c} className="pk-ctx-row" role="radio" data-testid={`models.picker.context-${c}`} aria-checked={c === actual} aria-disabled={disabled || !answered} aria-busy={(!capped && !answered) || undefined} tabIndex={c === actual ? 0 : -1} data-ctx={c} disabled={disabled} onClick={() => { if (active) chooseContext(active, c); }}><span>{k(c)}</span>{capped ? <small className="pk-cap">Max {k(activeMax)}</small> : <ContextMemory v={v} cpu={cpu} frees={frees} ready={answered} notNow={now} slow={slow} />}<span className="pk-context-check">{c === actual ? <Icon id="check" cls="s12" /> : null}</span></button>;
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
