import "../picker/picker.css";
import "./image-picker.css";
import { type KeyboardEvent, type ReactNode, useRef, useState } from "react";
import type { ImageChoice, ImageDownload, ImagePreset } from "@gates-local/contracts";
import { cardGb, gb, noGpu, timeLeft } from "../lib/words/format.ts";
import { Icon } from "../lib/ui/icons.tsx";
import { chosenImage, imageCard, sizeLabel } from "./image-choice.ts";
import { ImageMark } from "./ImageMark.tsx";
import { memoryRuler } from "../picker/picker-models.ts";
import { focusComposer } from "../composer/focus.ts";
import { downloadImageSetup, folderDialog, pickImage, saveImageFolder, startImage, stopImageDownload } from "../lib/session/index.ts";
import { type Failed, imageFailure } from "../lib/words/image-failure.ts";
import { NA, useStore } from "../lib/store/store.ts";
import { PHONE, closePop, closeTip, tabStops, useMedia } from "../lib/ui/ui.tsx";
import { requestFocus } from "../lib/ui/kit/focus.ts";
import { usePopover } from "../lib/ui/kit/popover.ts";
import { pickerEntry } from "../picker/picker-entry.ts";

// why: below this much room above the button the list and the sizes stop being usable
const CRAMPED = 280;
const TIER_ORDER = ["Fast", "Fast and balanced", "Balanced", "Best"];
const GROUP_ORDER = ["General", "Portraits and people", "Characters", "Pixel art", "Game sprites", "Backgrounds", "Icons", "Text and logos", "Painterly and concept art", "ComfyUI templates", "Your workflows", "Your models"];
const STYLES: readonly { readonly name: string; readonly key: string }[] = [
  { name: "General", key: "general" },
  { name: "People", key: "portraits" },
  { name: "Characters", key: "characters" },
  { name: "Pixel art", key: "pixel-art" },
  { name: "Game sprites", key: "sprites" },
  { name: "Backgrounds", key: "backgrounds" },
  { name: "Icons", key: "icons" },
  { name: "Text and logos", key: "text-logos" },
  { name: "Painterly and concept art", key: "painterly" },
];

type Row = ImagePreset & { readonly ready: boolean };
type Menu = "defaults" | "other";

const baseName = (file: string) => file.slice(Math.max(file.lastIndexOf("/"), file.lastIndexOf("\\")) + 1);

const rank = (group: string) => { const i = GROUP_ORDER.indexOf(group); return i < 0 ? GROUP_ORDER.length : i; };

const tierRank = (r: Row) => { const i = TIER_ORDER.indexOf(r.tier ?? ""); return r.tier === undefined ? TIER_ORDER.length + 1 : i < 0 ? TIER_ORDER.length : i; };

function grouped(rows: readonly Row[]): { name: string; rows: Row[] }[] {
  const by = new Map<string, Row[]>();
  for (const r of rows) by.set(r.group ?? "", [...by.get(r.group ?? "") ?? [], r]);
  const order = (list: Row[]) => [...list.filter((r) => r.tier !== undefined).toSorted((a, b) => tierRank(a) - tierRank(b)), ...list.filter((r) => r.tier === undefined && r.ready), ...list.filter((r) => r.tier === undefined && !r.ready)];
  return [...by.entries()].toSorted(([a], [b]) => rank(a) - rank(b)).map(([name, list]) => ({ name, rows: order(list) }));
}

function defaultsOf(rows: readonly Row[]): { style: string; row: Row }[] {
  const out: { style: string; row: Row }[] = [];
  for (const s of STYLES) {
    const row = rows.find((r) => r.style === s.key);
    if (row !== undefined) out.push({ style: s.name, row });
  }
  return out;
}

const tierTag = (p: Row) => p.tier === undefined ? null : <span className="pk-variant">{p.tier}</span>;

export function needsText(p: ImagePreset, button: boolean): string {
  if (p.why !== undefined) return p.why;
  const bytes = p.needs?.leftBytes ?? p.needs?.bytes;
  if (button && bytes !== undefined) return gb(bytes);
  const n = p.needs?.files.length ?? 0;
  return `Needs ${n} ${n === 1 ? "file" : "files"}${bytes === undefined ? "" : ` · ${gb(bytes)}`}`;
}

function sizeFor(preset: ImagePreset, width: number, height: number) {
  return preset.sizes.find((z) => z.width === width && z.height === height) ?? preset.sizes[0]!;
}

function SizeMemory({ bytes, card, cpu, number }: { bytes: number; card: number | undefined; cpu: boolean; number: boolean }) {
  const fits = card === undefined ? undefined : bytes <= card;
  const k = fits === undefined ? "pending" : fits ? "gpu" : "no";
  const word = cpu ? "runs in system memory" : fits === undefined ? "no GPU reading" : fits ? "fits the GPU" : `${gb(bytes - card!)} more than the GPU has`;
  const ruler = card === undefined || cpu ? undefined : memoryRuler(bytes, card);
  return <span className={`pk-cost ${k}`} role="img" aria-label={`${gb(bytes)} estimated; ${word}`}>
    {number ? <span className="pk-cost-caption"><span>{gb(bytes)}</span></span> : null}
    {ruler === undefined ? null : <span className="pk-cost-track"><i className="pk-cost-room" /><i className="pk-cost-fill" style={{ width: `${ruler.fill}%` }} />{ruler.overflow > 0 ? <i className="pk-cost-over" style={{ width: `${ruler.overflow}%` }} /> : null}<i className="pk-cost-edge" />{ruler.continues ? <b>→</b> : null}</span>}
  </span>;
}

export function middle(path: string, max = 34): string {
  if (path.length <= max) return path;
  const tail = Math.ceil((max - 1) * 0.6);
  return `${path.slice(0, max - 1 - tail)}…${path.slice(-tail)}`;
}

function amounts(d: ImageDownload): { done: number; total: number | undefined; pct: number } {
  const done = d.setupTotalBytes === undefined ? d.completedBytes : d.setupCompletedBytes ?? d.completedBytes;
  const total = d.setupTotalBytes ?? d.totalBytes;
  return { done, total, pct: total ? Math.min(100, Math.round((done / total) * 100)) : 0 };
}

export function ImagePicker() {
  const pop = useStore((s) => (s.pop?.id === "images" ? s.pop : null));
  const presets = useStore((s) => s.imagePresets);
  const status = useStore((s) => s.imageStatus);
  const pushed = useStore((s) => s.imageDownload);
  const view = useStore(chosenImage), chosen = view?.listed === true ? view : undefined;
  const gpu = useStore((s) => s.gpu);
  const phone = useMedia(PHONE), cpu = noGpu(gpu);
  const [menu, setMenu] = useState<Menu | null>(null);
  const [highlight, setHighlight] = useState<string | null>(null);
  const [step, setStep] = useState<"models" | "sizes">("models");
  const [error, setError] = useState<string | null>(null);
  const [rowError, setRowError] = useState<({ id: string } & Failed) | null>(null);
  const [saving, setSaving] = useState(false);
  const [starting, setStarting] = useState<"start" | "check" | null>(null);
  const canDownload = useStore((s) => s.unavailable["image.download"] !== true);
  const canStop = useStore((s) => s.unavailable["image.stopDownload"] !== true);
  const canStart = useStore((s) => s.unavailable["image.start"] !== true);
  const [startError, setStartError] = useState<Failed | null>(null);
  const [folderField, setFolderField] = useState<string | null>(null);
  const [folderError, setFolderError] = useState<string | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  const known = presets === undefined || presets === NA ? undefined : presets;
  const note = known?.noGpu ?? known?.slow;
  const listed: Row[] = known === undefined ? [] : [...known.presets.map((p) => ({ ...p, ready: true })), ...(known.others ?? []).map((p) => ({ ...p, ready: false }))];
  const defaults = defaultsOf(listed);
  const isDefault = new Set(defaults.map((d) => d.row.id));
  const others = grouped(listed.filter((p) => !isDefault.has(p.id)));
  const shown: Menu = menu ?? (defaults.length === 0 || (chosen !== undefined && !isDefault.has(chosen.preset.id)) ? "other" : "defaults");
  const rows = shown === "defaults" ? defaults.map((d) => d.row) : others.flatMap((g) => g.rows);
  const active = rows.find((p) => p.id === highlight) ?? rows.find((p) => p.id === chosen?.preset.id) ?? rows.find((p) => p.ready) ?? rows[0];
  const width = chosen?.width ?? 0, height = chosen?.height ?? 0;
  const download = pushed ?? known?.download;
  const downloading = download !== undefined && download.ended !== true;
  const fetching = new Set(downloading ? (listed.find((p) => p.id === download.preset)?.needs?.files ?? []).map(baseName) : []);
  const firstReady = rows.find((p) => p.ready)?.id;
  const same = active !== undefined && active.sizes.length > 1 && active.sizes.every((z) => z.bytes === active.sizes[0]!.bytes) ? active.sizes[0]!.bytes : undefined;

  if (pop === null && menu !== null) setMenu(null);
  const [entry] = useState(() => pickerEntry(ref, (root) =>
    root.querySelector<HTMLButtonElement>(".pk-menu:not([inert]) .pk-r.sel .pk-select") ?? root.querySelector<HTMLButtonElement>(".pk-menu:not([inert]) .pk-select, .pk-blank button")));
  usePopover(ref, pop !== null, (root) => {
    const anchor = document.getElementById("modelBtn");
    if (!anchor) return;
    root.style.maxHeight = "";
    if (phone) { root.style.left = `${Math.max(8, (window.innerWidth - root.offsetWidth) / 2)}px`; root.style.top = ""; return; }
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
    if (phone) { setStep("sizes"); requestFocus(() => ref.current?.querySelector<HTMLButtonElement>(".pk-back"), { preventScroll: true }); return; }
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
    if (failed !== null) setRowError({ id: p.id, ...failed });
  }
  async function changeFolder() {
    setFolderError(null);
    const dialog = folderDialog();
    if (dialog === undefined) { setFolderField(known?.disk?.folder ?? ""); return; }
    const picked = await dialog(known?.disk?.folder).catch(() => null);
    if (picked !== null) await saveFolder(picked);
  }
  async function saveFolder(folder: string) {
    const failed = await saveImageFolder(folder.trim() === "" ? null : folder.trim());
    if (failed === null) setFolderField(null);
    setFolderError(failed);
  }
  async function start(as: "start" | "check") {
    setStarting(as); setStartError(null);
    const failed = await startImage();
    setStarting(null); setStartError(failed);
  }
  function back() {
    setStep("models");
    requestFocus(() => ref.current?.querySelector<HTMLButtonElement>(".pk-menu:not([inert]) .pk-r.hl .pk-select, .pk-menu:not([inert]) .pk-select"), { preventScroll: true });
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
      requestFocus(() => ref.current?.querySelector<HTMLButtonElement>(".pk-ctx-row[aria-checked=true]") ?? ref.current?.querySelector<HTMLButtonElement>(".pk-ctx-row"), { preventScroll: true });
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

  function rowLabel(p: Row, style: string | undefined) {
    return style === undefined ? <><ImageMark family={p.family} /><span className="pk-name"><span className="pk-nm">{p.name}</span>{tierTag(p)}{check(p)}</span></>
      : <span className="pk-name"><span className="pk-nm">{style}</span>{check(p)}</span>;
  }
  const check = (p: Row) => p.ready && p.id === chosen?.preset.id ? <Icon id="check" cls="s12" /> : null;

  function readyRow(p: Row, style?: string) {
    return <div key={p.id} className={`pk-r${style === undefined ? "" : " style"}${p.id === chosen?.preset.id ? " sel" : ""}${p.id === active?.id ? " hl" : ""}`} role="option" data-testid="image.picker.option" aria-selected={p.id === chosen?.preset.id} data-preset={p.id} onMouseMove={() => setHighlight(p.id)}>
      <button type="button" className="pk-select" data-testid="image.picker.select" tabIndex={p.id === (chosen?.preset.id ?? firstReady) ? 0 : -1} aria-label={style ?? p.name} onClick={() => choose(p)}>{rowLabel(p, style)}</button>
    </div>;
  }

  function offRow(p: Row, style?: string) {
    const mine = download?.preset === p.id ? download : undefined;
    const kept = mine !== undefined && mine.ended === true && mine.state === "cancelled";
    const failed = mine !== undefined && mine.ended === true && mine.state === "error";
    const waits = downloading && (mine !== undefined || (p.needs?.files ?? []).some((f) => fetching.has(baseName(f))));
    const button = p.needs?.download === true && canDownload && !waits;
    const said: Failed = rowError?.id === p.id ? rowError : waits ? { message: "Waiting on the download" } : failed ? (mine.message === undefined ? { message: "The download failed." } : imageFailure(`download ${p.name}`, mine.message)) : { message: needsText(p, button) };
    const reason = said.message;
    return <div key={p.id} className={`pk-r off${style === undefined ? "" : " style"}${p.id === active?.id ? " hl" : ""}`} role="option" data-testid="image.picker.unready-option" aria-selected={false} data-preset={p.id} data-state={waits ? "waiting" : "needs"} onMouseMove={() => setHighlight(p.id)}>
      <button type="button" className="pk-select" data-testid="image.picker.unready-select" tabIndex={-1} aria-disabled="true" aria-label={style ?? p.name} aria-describedby={`pk-why-${p.id}`} onClick={() => choose(p)}>{rowLabel(p, style)}</button>
      {button
        ? <button type="button" className="pk-act" data-testid="image.picker.download" aria-label={`${kept ? "Resume downloading" : "Download"} ${p.name}`} data-tip={kept ? "Resume" : "Download"} disabled={downloading} onClick={() => { setHighlight(p.id); void fetchSetup(p); }}><Icon id={kept ? "redo" : "download"} /></button>
        : null}
      <div className="pk-why" id={`pk-why-${p.id}`} data-tipt={reason} data-why={said.why}><span className="pk-why-t t">{reason}</span></div>
    </div>;
  }

  function diskRow() {
    const disk = known?.disk;
    if (disk === undefined || !canDownload) return null;
    const run = download !== undefined && (downloading || download.state === "cancelled") ? download : undefined;
    const name = listed.find((p) => p.id === run?.preset)?.name ?? run?.preset ?? "";
    const left = active?.needs?.download === true ? active.needs.leftBytes ?? active.needs.bytes : undefined;
    const short = left !== undefined && disk.freeBytes !== undefined && disk.freeBytes < left;
    const field = folderField !== null;
    let numbers: ReactNode;
    if (run !== undefined) {
      const { done, total, pct } = amounts(run);
      const time = downloading && run.state === "downloading" && run.bytesPerSecond && total ? ` · ${timeLeft(Math.max(0, total - done) / run.bytesPerSecond)} left` : "";
      numbers = <>
        <span className="prog" role="progressbar" aria-label={`${name} download`} aria-valuenow={pct}><i style={{ width: `${pct}%` }} /></span>
        <span className="pk-disk-n" data-testid="image.picker.download-amount">{run.state === "queued" ? "Starting" : total ? `${gb(done)} of ${gb(total)}${time}` : gb(done)}</span>
        {downloading && canStop ? <button type="button" className="pk-act" data-testid="image.picker.stop-download" aria-label={`Stop downloading ${name}`} data-tip="Stop" onClick={() => void stopImageDownload(run.preset).then((failed) => { if (failed !== null) setRowError({ id: run.preset, ...failed }); })}><Icon id="x" /></button> : null}
      </>;
    } else if (download?.ended === true && download.state === "done" && download.message !== undefined && left === undefined) {
      numbers = <span className="pk-disk-n pk-disk-note" role="status" data-testid="image.picker.download-note">{download.message}</span>;
    } else {
      numbers = <span className="pk-disk-n">
        {left === undefined ? null : <span data-testid="image.picker.disk-left">{gb(left)} to fetch{disk.freeBytes === undefined ? "" : " · "}</span>}
        {disk.freeBytes === undefined ? null : <span className={short ? "short" : undefined} data-testid="image.picker.disk-free">{gb(disk.freeBytes)} free on disk</span>}
      </span>;
    }
    return <div className="pk-disk" data-testid="image.picker.disk">
      <button type="button" className="pk-act" data-testid="image.picker.change-folder" aria-label="Change the download folder" data-tip="Change folder" aria-pressed={field || undefined} disabled={downloading} onClick={() => void changeFolder()}><Icon id="folder" /></button>
      {field
        ? <input className="pk-disk-field" data-testid="image.picker.folder-field" aria-label="Download folder" value={folderField} autoFocus spellCheck={false}
            onChange={(e) => setFolderField(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); void saveFolder(folderField); } else if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); setFolderField(null); setFolderError(null); } }} />
        : <span className="pk-disk-folder" data-testid="image.picker.disk-folder">{disk.folder === undefined ? "No folder yet" : middle(disk.folder)}</span>}
      {folderError === null ? numbers : <span className="pk-disk-n short" role="status">{folderError}</span>}
    </div>;
  }

  if (pop === null) return null;
  const card = imageCard(gpu);
  const disk = diskRow();
  const close = <button className="pk-close" data-testid="image.picker.close" aria-label="Close" onClick={() => closePop(true)}><Icon id="x" /></button>;
  if (listed.length === 0) {
    const empty = known === undefined ? (presets === NA ? "Image models are not available in this build." : "Reading the image models…")
      : known.readAt === undefined ? "Image models show here once ComfyUI has run."
      : "ComfyUI has none of the files these image models load.";
    const state = status === undefined || status === NA ? undefined : status.state;
    const as = state === "stopped" ? "start" : "check";
    const label = starting === "start" || state === "starting" ? "Starting ComfyUI…" : starting === "check" ? "Checking…" : as === "start" ? "Start ComfyUI" : "Check again";
    return <div ref={entry} id="imagePicker" className="model-picker image-picker open" role="dialog" data-testid="image.picker.blank" aria-label="Choose an image model" aria-modal={phone} onKeyDown={keys}>
      <div className="pk-blank">
        <p>{empty}{startError === null ? null : <span className="pk-blank-error" role="status" data-why={startError.why}>{startError.message}</span>}</p>
        {known === undefined || !canStart ? null : <button type="button" className="btn outline" data-testid="image.picker.start-comfy" disabled={starting !== null || state === "starting"} onClick={() => void start(as)}>{label}</button>}
        {close}
      </div>
    </div>;
  }
  return <div ref={entry} id="imagePicker" className={`model-picker image-picker open${step === "sizes" ? " step-context" : ""}`} role="dialog" data-testid="image.picker.dialog" aria-label="Choose an image model" aria-modal={phone} aria-busy={saving || undefined} onKeyDown={keys}>
    <div className="pk-layout">
      <nav className="pk-rail" aria-label="Image model menus" inert={phone && step === "sizes"}>
        <button className="pk-fam" data-testid="image.picker.defaults" aria-label="Defaults" data-tip="Defaults" aria-pressed={shown === "defaults"} onClick={() => switchTo("defaults")}><Icon id="star" /></button>
        <button className="pk-fam" data-testid="image.picker.other" aria-label="Other models" data-tip="Other models" aria-pressed={shown === "other"} onClick={() => switchTo("other")}><Icon id="box" /></button>
      </nav>
      <div className="pk-main" inert={phone && step === "sizes"}>
        <div className="pk-search">{close}</div>
        <div className="pk-list-scroll">
          <div className="pk-menus">
            <div className="pk-menu" role="listbox" data-testid="image.picker.defaults-list" aria-label="Defaults" inert={shown !== "defaults"} onKeyDown={listKeys}>
              {defaults.length === 0 ? <p className="pk-empty">No style has a setup here yet.</p> : defaults.map(({ style, row }) => row.ready ? readyRow(row, style) : offRow(row, style))}
            </div>
            <div className="pk-menu" role="listbox" data-testid="image.picker.other-list" aria-label="Other models" inert={shown !== "other"} onKeyDown={listKeys}>
              {others.length === 0 ? <p className="pk-empty">Every setup here is a default.</p> : others.map((g) => <div key={g.name} role="group" aria-label={g.name || undefined}>
                {g.name === "" ? null : <div className="pk-group" aria-hidden="true">{g.name}</div>}
                {g.rows.map((p) => p.ready ? readyRow(p) : offRow(p))}
              </div>)}
            </div>
          </div>
        </div>
      </div>
      <section className="pk-context" aria-label="Size" inert={phone && step !== "sizes"}>
        <header className="pk-context-head"><button className="pk-back" data-testid="image.picker.back" aria-label="Back to image models" onClick={back}><Icon id="left" /></button><span data-testid="image.picker.model">{active?.model ?? active?.name}</span>{same === undefined ? null : <small>{gb(same)}</small>}</header>
        <div className="pk-context-rows" role="radiogroup" aria-label="Size" data-testid="image.picker.sizes" onKeyDown={(e) => {
          if (e.key === "ArrowLeft") { e.preventDefault(); back(); return; }
          if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
          e.preventDefault();
          const buttons = [...e.currentTarget.querySelectorAll<HTMLButtonElement>("button:enabled")], i = buttons.findIndex((b) => b === document.activeElement);
          buttons[(i + (e.key === "ArrowDown" ? 1 : -1) + buttons.length) % buttons.length]?.focus();
        }}>
          {active?.sizes.map((z) => {
            const on = active.id === chosen?.preset.id && z.width === width && z.height === height;
            return <button key={`${z.width}x${z.height}`} className="pk-ctx-row" role="radio" data-testid={`image.picker.size-${z.width}x${z.height}`} aria-checked={on} tabIndex={on ? 0 : -1} disabled={!active.ready} data-size={`${z.width}x${z.height}`} onClick={() => void pick({ preset: active.id, width: z.width, height: z.height })}>
              <span>{sizeLabel(z.width, z.height)}</span>
              <SizeMemory bytes={z.bytes} card={card} cpu={cpu} number={same === undefined} />
              <span className="pk-context-check">{on ? <Icon id="check" cls="s12" /> : null}</span>
            </button>;
          })}
        </div>
        {error === null ? null : <p className="pk-help pk-choice" role="status">{error}</p>}
      </section>
    </div>
    <footer className="pk-bottom">
      {disk}
      {disk === null || note !== undefined ? <span className="pk-nogpu" role={note === undefined ? undefined : "status"}>{note}</span> : null}
      <span className="pk-gpu" data-testid="image.picker.card">{note !== undefined && (cpu || card === undefined) ? null : cpu ? "Runs in system memory" : card === undefined ? "GPU reading unavailable" : `${cardGb(card)} GPU`}</span>
    </footer>
  </div>;
}
