// The composer's model picker while Image is on: two menus on the rail, Defaults (one row per
// style, named by the style alone, running the setup this card's level gets for it) and Other
// models (the rest in their groups, with family marks), the highlighted one's sizes on the
// right, the GPU memory line below. Both menus are laid in one cell with the other hidden, and
// the sizes never set the height, so the picker is as tall on either menu and nothing moves on a
// click. The same shape and parts as Picker.tsx; what a chat model needs (search, favorites,
// context lengths) is not here. A setup ComfyUI lacks files or nodes for is listed greyed out
// with its reason, and a Download button when the app can fetch every missing file
// (image.download, with Stop). With nothing to list the picker is one row that says why, with
// Start ComfyUI or Check again: nothing starts on open.
import "./picker.css";
import "./image-picker.css";
import { type KeyboardEvent, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { ImageChoice, ImageDownload, ImagePreset } from "@gates-local/contracts";
import { gb, noGpu, timeLeft } from "./format.ts";
import { Icon } from "./icons.tsx";
import { chosenImage, imageFit, sizeLabel } from "./image-choice.ts";
import { ImageMark } from "./ImageMark.tsx";
import { memoryRuler } from "./picker-models.ts";
import { focusComposer } from "./Sidebar.tsx";
import { downloadImageSetup, loadImagePresets, pickImage, startImage, stopImageDownload } from "./session.ts";
import { NA, useStore } from "./store.ts";
import { PHONE, closePop, closeTip, esc, isTouch, tabStops, useMedia } from "./ui.tsx";

/** Below this height the list and the sizes stop being usable. */
const CRAMPED = 280;
/** The server's tier labels in their order (presets.ts TIERS); one setup can be two tiers' pick. */
const TIER_ORDER = ["Fast", "Fast and balanced", "Balanced", "Best"];
/** The server's groups, theme defaults first (presets.ts GROUPS); one it names that is not here goes last. */
const GROUP_ORDER = ["General", "Portraits and people", "Pixel art", "Game sprites", "Backgrounds", "ComfyUI templates", "Your workflows", "Your models"];
/**
 * Defaults' styles, named and ordered as the style bench names them, each with the server group
 * its setup is listed under. A style shows once the app ships a setup for it: Icons, Text and
 * logos and Painterly and concept art have none until the bench measures a winner.
 */
const STYLES: readonly { readonly name: string; readonly group: string }[] = [
  { name: "General", group: "General" },
  { name: "People", group: "Portraits and people" },
  { name: "Pixel art", group: "Pixel art" },
  { name: "Game sprites", group: "Game sprites" },
  { name: "Backgrounds", group: "Backgrounds" },
  { name: "Icons", group: "Icons" },
  { name: "Text and logos", group: "Text and logos" },
  { name: "Painterly and concept art", group: "Painterly and concept art" },
];

type Row = ImagePreset & { readonly ready: boolean };
type Menu = "defaults" | "other";

/** A file by its name, without the folder a setup lists it under; the download fetches by this name. */
const baseName = (file: string) => file.slice(Math.max(file.lastIndexOf("/"), file.lastIndexOf("\\")) + 1);

const rank = (group: string) => { const i = GROUP_ORDER.indexOf(group); return i < 0 ? GROUP_ORDER.length : i; };

const tierRank = (r: Row) => { const i = TIER_ORDER.indexOf(r.tier ?? ""); return r.tier === undefined ? TIER_ORDER.length + 1 : i < 0 ? TIER_ORDER.length : i; };

/**
 * Rows in their groups: groups in GROUP_ORDER, then as first seen; in each, this GPU's tier rows
 * first in tier order (ready or still to download), then ready rows, then the rest.
 */
function grouped(rows: readonly Row[]): { name: string; rows: Row[] }[] {
  const by = new Map<string, Row[]>();
  for (const r of rows) by.set(r.group ?? "", [...by.get(r.group ?? "") ?? [], r]);
  const order = (list: Row[]) => [...list.filter((r) => r.tier !== undefined).toSorted((a, b) => tierRank(a) - tierRank(b)), ...list.filter((r) => r.tier === undefined && r.ready), ...list.filter((r) => r.tier === undefined && !r.ready)];
  return [...by.entries()].toSorted(([a], [b]) => rank(a) - rank(b)).map(([name, list]) => ({ name, rows: order(list) }));
}

/**
 * Defaults: one row per style the app has a setup for, the one this card's level runs. General's
 * is the Fast tier's, the server's pick for the card; a theme's is its group's first. With no
 * tier (under 4 GB, or the CPU) there is no measured pick for General, so it has no row here and
 * its setups stay in Other models.
 */
function defaultsOf(rows: readonly Row[]): { style: string; row: Row }[] {
  const out: { style: string; row: Row }[] = [];
  for (const s of STYLES) {
    const list = grouped(rows.filter((r) => r.group === s.group))[0]?.rows ?? [];
    const row = s.group === "General" ? list.find((r) => r.tier?.startsWith("Fast") === true) : list[0];
    if (row !== undefined) out.push({ style: s.name, row });
  }
  return out;
}

/** A tier row's quiet label after its name, as the chat picker shows a variant. */
const tierTag = (p: Row) => p.tier === undefined ? null : <span className="pk-variant">{p.tier}</span>;

/** Why a greyed row cannot run: what ComfyUI lacks, in words, or the files it needs and their size. */
function needsText(p: ImagePreset): string {
  if (p.why !== undefined) return p.why;
  const n = p.needs?.files.length ?? 0, bytes = p.needs?.bytes;
  return `Needs ${n} ${n === 1 ? "file" : "files"}${bytes === undefined ? "" : ` · ${gb(bytes)}`}`;
}

/** The size a preset runs at when its row is picked: the chosen size when it has it, else its first. */
function sizeFor(preset: ImagePreset, width: number, height: number) {
  return preset.sizes.find((z) => z.width === width && z.height === height) ?? preset.sizes[0]!;
}

type Fit = ReturnType<typeof imageFit>;
/** gpu fits in what is free now; held fits in memory ComfyUI already holds; spill stops the chat model first; no is too big. */
type Kind = "pending" | "gpu" | "held" | "spill" | "no";

function fitKind(bytes: number, fit: Fit, free: number | undefined): Kind {
  if (fit === undefined) return "pending";
  if (fit.v.k === "no") return "no";
  if (fit.frees) return "spill";
  return free !== undefined && bytes > free ? "held" : "gpu";
}

/** What the size row's mark means, for its tooltip and its label. */
function fitWord(kind: Kind, fit: Fit, cpu: boolean): string {
  if (fit === undefined) return "No GPU reading";
  if (cpu) return "Runs in system memory";
  if (fit.v.k === "no") return `Too big: ${gb(fit.v.amt)} short`;
  return kind === "spill" ? "Stops the chat model first" : kind === "held" ? "Uses memory ComfyUI holds" : "Fits on the GPU";
}

/**
 * A size row's memory: the chat picker's ruler against what is free now, green only when the
 * size fits in it; amber when it needs memory ComfyUI holds or the chat model stopped, red when
 * it is too big. The number is on the row only when the sizes differ; else the head says it once.
 */
function SizeMemory({ bytes, fit, free, cpu, number }: { bytes: number; fit: Fit; free: number | undefined; cpu: boolean; number: boolean }) {
  const k = fitKind(bytes, fit, free);
  const ruler = fit === undefined || cpu || free === undefined ? undefined : memoryRuler(bytes, free);
  return <span className={`pk-cost ${k}`} role="img" aria-label={`${gb(bytes)} estimated; ${fitWord(k, fit, cpu)}`}>
    {number ? <span className="pk-cost-caption"><span>{gb(bytes)}</span></span> : null}
    {ruler === undefined ? null : <span className="pk-cost-track"><i className="pk-cost-room" /><i className="pk-cost-fill" style={{ width: `${ruler.fill}%` }} />{ruler.overflow > 0 ? <i className="pk-cost-over" style={{ width: `${ruler.overflow}%` }} /> : null}<i className="pk-cost-edge" />{ruler.continues ? <b>→</b> : null}</span>}
  </span>;
}

/**
 * A greyed row's second line while its files download: one bar for the whole setup, then which
 * file, how far and how long, short enough for the row. The setup's bytes when the server knows
 * every file's size, else this file's.
 */
function Downloading({ d, name }: { d: ImageDownload; name: string }) {
  const done = d.setupTotalBytes === undefined ? d.completedBytes : d.setupCompletedBytes ?? d.completedBytes;
  const total = d.setupTotalBytes ?? d.totalBytes;
  const pct = total ? Math.min(100, Math.round((done / total) * 100)) : 0;
  const left = d.state === "downloading" && d.bytesPerSecond && total ? ` · ${timeLeft(Math.max(0, total - done) / d.bytesPerSecond)} left` : "";
  const words = d.state === "queued" ? "Starting" : d.state === "verifying" ? `File ${d.file}/${d.files} · checking` : `File ${d.file}/${d.files} · ${pct}%${left}`;
  return <>
    <span className="prog" role="progressbar" aria-label={`${name} download`} aria-valuenow={pct}><i style={{ width: `${pct}%` }} /></span>
    <span className="pk-why-t">{words}</span>
  </>;
}

export function ImagePicker() {
  const pop = useStore((s) => (s.pop?.id === "images" ? s.pop : null));
  const presets = useStore((s) => s.imagePresets);
  const status = useStore((s) => s.imageStatus);
  const pushed = useStore((s) => s.imageDownload);
  // the picked setup; a default the server says this GPU cannot run is not shown as one
  const view = useStore(chosenImage), chosen = view?.listed === true ? view : undefined;
  const gpu = useStore((s) => s.gpu);
  const phone = useMedia(PHONE), cpu = noGpu(gpu);
  // the menu pressed on the rail since the picker opened; until then the one holding the pick
  const [menu, setMenu] = useState<Menu | null>(null);
  const [highlight, setHighlight] = useState<string | null>(null);
  const [step, setStep] = useState<"models" | "sizes">("models");
  const [error, setError] = useState<string | null>(null);
  const [rowError, setRowError] = useState<{ id: string; message: string } | null>(null);
  const [saving, setSaving] = useState(false);
  // what the empty picker's button was pressed as: its words stay until the start or the look ends
  const [starting, setStarting] = useState<"start" | "check" | null>(null);
  // what this listener refuses (the phone's): its controls are not shown
  const canDownload = useStore((s) => s.unavailable["image.download"] !== true);
  const canStop = useStore((s) => s.unavailable["image.stopDownload"] !== true);
  const canStart = useStore((s) => s.unavailable["image.start"] !== true);
  const [startError, setStartError] = useState<string | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  const known = presets === undefined || presets === NA ? undefined : presets;
  const listed: Row[] = known === undefined ? [] : [...known.presets.map((p) => ({ ...p, ready: true })), ...(known.others ?? []).map((p) => ({ ...p, ready: false }))];
  const defaults = defaultsOf(listed);
  const isDefault = new Set(defaults.map((d) => d.row.id));
  const others = grouped(listed.filter((p) => !isDefault.has(p.id)));
  const shown: Menu = menu ?? (defaults.length === 0 || (chosen !== undefined && !isDefault.has(chosen.preset.id)) ? "other" : "defaults");
  const rows = shown === "defaults" ? defaults.map((d) => d.row) : others.flatMap((g) => g.rows);
  const active = rows.find((p) => p.id === highlight) ?? rows.find((p) => p.id === chosen?.preset.id) ?? rows.find((p) => p.ready) ?? rows[0];
  const width = chosen?.width ?? 0, height = chosen?.height ?? 0;
  // the newest word on a download: a push, else what the list said when it was read
  const download = pushed ?? known?.download;
  const downloading = download !== undefined && download.ended !== true;
  // the running setup's files, by name: a row that needs one of them waits on that download
  const fetching = new Set(downloading ? (listed.find((p) => p.id === download.preset)?.needs?.files ?? []).map(baseName) : []);
  const firstReady = rows.find((p) => p.ready)?.id;
  // a number the same at every size is said once, in the head
  const same = active !== undefined && active.sizes.length > 1 && active.sizes.every((z) => z.bytes === active.sizes[0]!.bytes) ? active.sizes[0]!.bytes : undefined;

  // the list is ComfyUI's: read it again each time the picker opens; a closed picker forgets its menu
  useEffect(() => { if (pop !== null) void loadImagePresets(); else setMenu(null); }, [pop !== null]);
  useLayoutEffect(() => {
    if (pop === null) return;
    if (isTouch() && !pop.kb) ref.current?.querySelector<HTMLButtonElement>(".pk-close")?.focus({ preventScroll: true });
    else (ref.current?.querySelector<HTMLButtonElement>(".pk-menu:not([inert]) .pk-r.sel .pk-select") ?? ref.current?.querySelector<HTMLButtonElement>(".pk-menu:not([inert]) .pk-select, .pk-blank button"))?.focus({ preventScroll: true });
  }, [pop]);
  useLayoutEffect(() => {
    const root = ref.current, anchor = document.getElementById("modelBtn");
    if (pop === null || !root || !anchor) return;
    root.style.maxHeight = "";
    if (phone) { root.style.left = `${Math.max(8, (window.innerWidth - root.offsetWidth) / 2)}px`; root.style.top = ""; return; }
    // Placed as the chat picker is: right edge on the button's, above it unless that is cramped.
    const r = anchor.getBoundingClientRect(), pw = root.offsetWidth, ph = root.offsetHeight;
    const above = r.top - 6 - 8, below = window.innerHeight - r.bottom - 6 - 8;
    const up = ph <= above || above >= CRAMPED || above >= below;
    const h = Math.min(ph, up ? above : below);
    if (h < ph) root.style.maxHeight = `${h}px`;
    root.style.left = `${Math.max(8, Math.min(r.right - pw, window.innerWidth - pw - 8))}px`;
    root.style.top = `${up ? r.top - 6 - h : r.bottom + 6}px`;
  });

  async function pick(choice: ImageChoice) {
    if (saving) return;
    if (choice.preset !== chosen?.preset.id || choice.width !== width || choice.height !== height) {
      setSaving(true);
      setError(null);
      const failed = await pickImage(choice);
      setSaving(false);
      if (failed !== null) { setError(failed); return; }
    }
    closeTip(); closePop(); focusComposer();
  }
  function choose(preset: Row) {
    setHighlight(preset.id);
    if (phone) { setStep("sizes"); requestAnimationFrame(() => ref.current?.querySelector<HTMLButtonElement>(".pk-back")?.focus({ preventScroll: true })); return; }
    // a greyed row shows its sizes and picks nothing
    if (!preset.ready) return;
    const size = sizeFor(preset, width, height);
    void pick({ preset: preset.id, width: size.width, height: size.height });
  }
  function switchTo(m: Menu) {
    setMenu(m); setHighlight(null); setStep("models");
  }
  async function fetchSetup(p: Row) {
    setRowError(null);
    const failed = await downloadImageSetup(p.id);
    if (failed !== null) setRowError({ id: p.id, message: failed });
  }
  async function stopSetup(p: Row) {
    const failed = await stopImageDownload(p.id);
    if (failed !== null) setRowError({ id: p.id, message: failed });
  }
  async function start(as: "start" | "check") {
    setStarting(as); setStartError(null);
    const failed = await startImage();
    setStarting(null); setStartError(failed);
  }
  function back() {
    setStep("models");
    requestAnimationFrame(() => ref.current?.querySelector<HTMLButtonElement>(".pk-menu:not([inert]) .pk-r.hl .pk-select, .pk-menu:not([inert]) .pk-select")?.focus({ preventScroll: true }));
  }
  function listKeys(e: KeyboardEvent<HTMLDivElement>) {
    const buttons = [...e.currentTarget.querySelectorAll<HTMLButtonElement>(".pk-select")];
    const i = buttons.findIndex((b) => b === document.activeElement);
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      const next = buttons[(i + (e.key === "ArrowDown" ? 1 : -1) + buttons.length) % buttons.length];
      next?.focus();
      setHighlight(next?.closest<HTMLElement>("[data-preset]")?.dataset.preset ?? null);
    } else if (e.key === "ArrowRight") {
      e.preventDefault();
      if (phone) setStep("sizes");
      requestAnimationFrame(() => (ref.current?.querySelector<HTMLButtonElement>(".pk-ctx-row[aria-checked=true]") ?? ref.current?.querySelector<HTMLButtonElement>(".pk-ctx-row"))?.focus({ preventScroll: true }));
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

  /** What a row shows first: a Defaults row the style alone, the setup in its tip; any other row its mark and name. */
  function rowLabel(p: Row, style: string | undefined) {
    return style === undefined ? <><ImageMark family={p.family} /><span className="pk-name"><span className="pk-nm">{p.name}</span>{tierTag(p)}{check(p)}</span></>
      : <span className="pk-name"><span className="pk-nm">{style}</span>{check(p)}</span>;
  }
  const check = (p: Row) => p.ready && p.id === chosen?.preset.id ? <Icon id="check" cls="s12" /> : null;

  /** A row that runs now: picked by a press. */
  function readyRow(p: Row, style?: string) {
    return <div key={p.id} className={`pk-r${style === undefined ? "" : " style"}${p.id === chosen?.preset.id ? " sel" : ""}${p.id === active?.id ? " hl" : ""}`} role="option" aria-selected={p.id === chosen?.preset.id} data-preset={p.id} onMouseMove={() => setHighlight(p.id)}>
      <button type="button" className="pk-select" tabIndex={p.id === (chosen?.preset.id ?? firstReady) ? 0 : -1} aria-label={style ?? p.name} data-tip={style === undefined ? undefined : esc(p.name)} onClick={() => choose(p)}>{rowLabel(p, style)}</button>
    </div>;
  }

  /** A row ComfyUI cannot run yet: greyed, its reason or its download on the second line, the whole reason in its tip. */
  function offRow(p: Row, style?: string) {
    const mine = download?.preset === p.id ? download : undefined;
    const running = mine !== undefined && mine.ended !== true;
    const stopped = mine !== undefined && mine.ended === true && mine.state !== "done";
    // another setup's download brings this row's files: its progress here, said once, with no button
    const waits = !running && downloading && (p.needs?.files ?? []).some((f) => fetching.has(baseName(f)));
    const shownDownload = running ? mine : waits ? download : undefined;
    const reason = rowError?.id === p.id ? rowError.message : stopped ? mine.message ?? "The download stopped." : needsText(p);
    return <div key={p.id} className={`pk-r off${style === undefined ? "" : " style"}${p.id === active?.id ? " hl" : ""}`} role="option" aria-selected={false} data-preset={p.id} onMouseMove={() => setHighlight(p.id)}>
      <button type="button" className="pk-select" tabIndex={-1} aria-disabled="true" aria-label={style ?? p.name} aria-describedby={`pk-why-${p.id}`} data-tip={style === undefined ? undefined : esc(p.name)} onClick={() => choose(p)}>{rowLabel(p, style)}</button>
      {running
        ? canStop ? <button type="button" className="pk-act" aria-label={`Stop downloading ${p.name}`} data-tip="Stop" onClick={() => void stopSetup(p)}><Icon id="x" /></button> : null
        : p.needs?.download === true && canDownload && !waits
          ? <button type="button" className="pk-act" aria-label={`Download ${p.name}`} data-tip={stopped ? "Download again" : "Download"} disabled={downloading} onClick={() => void fetchSetup(p)}><Icon id="download" /></button>
          : null}
      {shownDownload !== undefined
        ? <div className="pk-why" id={`pk-why-${p.id}`}><Downloading d={shownDownload} name={p.name} /></div>
        : <div className="pk-why" id={`pk-why-${p.id}`} data-tipt={reason}><span className="pk-why-t t">{reason}</span></div>}
    </div>;
  }

  if (pop === null) return null;
  const free = gpu && gpu !== NA ? gpu.freeBytes : undefined;
  const close = <button className="pk-close" aria-label="Close" onClick={() => closePop(true)}><Icon id="x" /></button>;
  if (listed.length === 0) {
    const empty = known === undefined ? (presets === NA ? "Image models are not available in this build." : "Reading the image models…")
      : known.readAt === undefined ? "Image models show here once ComfyUI has run."
      : "ComfyUI has none of the files these image models load.";
    const state = status === undefined || status === NA ? undefined : status.state;
    // the app's own ComfyUI is stopped: Start it; otherwise there is nothing the app can start, so look again
    // a start keeps saying so while ComfyUI comes up, though its state is then "starting", not "stopped"
    const as = state === "stopped" ? "start" : "check";
    const label = starting === "start" || state === "starting" ? "Starting ComfyUI…" : starting === "check" ? "Checking…" : as === "start" ? "Start ComfyUI" : "Check again";
    return <div ref={ref} id="imagePicker" className="model-picker image-picker open blank" role="dialog" aria-label="Choose an image model" aria-modal={phone} onKeyDown={keys}>
      <div className="pk-blank">
        <p>{empty}{startError === null ? null : <span className="pk-blank-error" role="status">{startError}</span>}</p>
        {known === undefined || !canStart ? null : <button type="button" className="btn outline" disabled={starting !== null || state === "starting"} onClick={() => void start(as)}>{label}</button>}
        {close}
      </div>
    </div>;
  }
  return <div ref={ref} id="imagePicker" className={`model-picker image-picker open${step === "sizes" ? " step-context" : ""}`} role="dialog" aria-label="Choose an image model" aria-modal={phone} aria-busy={saving || undefined} onKeyDown={keys}>
    <div className="pk-layout">
      <nav className="pk-rail" aria-label="Image model menus" inert={phone && step === "sizes"}>
        <button className="pk-fam" aria-label="Defaults" data-tip="Defaults" aria-pressed={shown === "defaults"} onClick={() => switchTo("defaults")}><Icon id="star" /></button>
        <button className="pk-fam" aria-label="Other models" data-tip="Other models" aria-pressed={shown === "other"} onClick={() => switchTo("other")}><Icon id="box" /></button>
      </nav>
      <div className="pk-main" inert={phone && step === "sizes"}>
        {/* a phone's Close; the button that opened the picker already names it */}
        <div className="pk-search">{close}</div>
        <div className="pk-list-scroll">
          {/* both menus in one cell, the other hidden: the list is as tall on either */}
          <div className="pk-menus">
            <div className="pk-menu" role="listbox" aria-label="Defaults" inert={shown !== "defaults"} onKeyDown={listKeys}>
              {defaults.length === 0 ? <p className="pk-empty">No style has a setup here yet.</p> : defaults.map(({ style, row }) => row.ready ? readyRow(row, style) : offRow(row, style))}
            </div>
            <div className="pk-menu" role="listbox" aria-label="Other models" inert={shown !== "other"} onKeyDown={listKeys}>
              {others.length === 0 ? <p className="pk-empty">Every setup here is a default.</p> : others.map((g) => <div key={g.name} role="group" aria-label={g.name || undefined}>
                {g.name === "" ? null : <div className="pk-group" aria-hidden="true">{g.name}</div>}
                {g.rows.map((p) => p.ready ? readyRow(p) : offRow(p))}
              </div>)}
            </div>
          </div>
        </div>
      </div>
      <section className="pk-context" aria-label="Size" inert={phone && step !== "sizes"}>
        <header className="pk-context-head"><button className="pk-back" aria-label="Back to image models" onClick={back}><Icon id="left" /></button><span>{active?.name}</span>{same === undefined ? null : <small>{gb(same)}</small>}</header>
        <div className="pk-context-rows" role="radiogroup" aria-label="Size" onKeyDown={(e) => {
          if (e.key === "ArrowLeft") { e.preventDefault(); back(); return; }
          if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
          e.preventDefault();
          const buttons = [...e.currentTarget.querySelectorAll<HTMLButtonElement>("button:enabled")], i = buttons.findIndex((b) => b === document.activeElement);
          buttons[(i + (e.key === "ArrowDown" ? 1 : -1) + buttons.length) % buttons.length]?.focus();
        }}>
          {active?.sizes.map((z) => {
            const on = active.id === chosen?.preset.id && z.width === width && z.height === height;
            const fit = imageFit(z.bytes, gpu);
            return <button key={`${z.width}x${z.height}`} className="pk-ctx-row" role="radio" aria-checked={on} tabIndex={on ? 0 : -1} disabled={!active.ready} data-size={`${z.width}x${z.height}`} data-tip={fitWord(fitKind(z.bytes, fit, free), fit, cpu)} onClick={() => void pick({ preset: active.id, width: z.width, height: z.height })}>
              <span>{sizeLabel(z.width, z.height)}</span>
              <SizeMemory bytes={z.bytes} fit={fit} free={free} cpu={cpu} number={same === undefined} />
              <span className="pk-context-check">{on ? <Icon id="check" cls="s12" /> : null}</span>
            </button>;
          })}
        </div>
        {error === null ? null : <p className="pk-help pk-choice" role="status">{error}</p>}
      </section>
    </div>
    {/* under 4 GB or on the CPU: no default, said once; the free figure stays when there is one */}
    <footer className="pk-bottom"><span className="pk-nogpu" role={known?.noGpu === undefined ? undefined : "status"}>{known?.noGpu}</span><span>{known?.noGpu !== undefined && (cpu || free === undefined) ? null : cpu ? "Runs in system memory" : free === undefined ? "GPU reading unavailable" : `${gb(free)} free`}</span></footer>
  </div>;
}
