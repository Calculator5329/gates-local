// The composer's model picker while Image is on: image models on the left, the chosen one's sizes
// on the right, the GPU memory line below. The same shape and parts as Picker.tsx; what a chat
// model needs (search, favorites, context lengths, downloads) is not here.
import "./picker.css";
import "./image-picker.css";
import { type KeyboardEvent, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { ImageChoice, ImagePreset } from "@gates-local/contracts";
import { gb, noGpu } from "./format.ts";
import { Icon } from "./icons.tsx";
import { chosenImage, imageFit, sizeLabel } from "./image-choice.ts";
import { ImageMark } from "./ImageMark.tsx";
import { ContextMemory } from "./Picker.tsx";
import { focusComposer } from "./Sidebar.tsx";
import { loadImagePresets, updateSettings } from "./session.ts";
import { NA, useStore } from "./store.ts";
import { PHONE, closePop, closeTip, isTouch, tabStops, useMedia } from "./ui.tsx";

const MARGIN = 512 * 1024 ** 2;
/** Below this height the list and the sizes stop being usable. */
const CRAMPED = 280;
const FAMILY: Readonly<Record<string, string>> = { sdxl: "SDXL", flux: "FLUX" };
const familyName = (family: string) => FAMILY[family] ?? family;

/** The size a preset runs at when its row is picked: the chosen size when it has it, else its first. */
function sizeFor(preset: ImagePreset, width: number, height: number) {
  return preset.sizes.find((z) => z.width === width && z.height === height) ?? preset.sizes[0]!;
}

export function ImagePicker() {
  const pop = useStore((s) => (s.pop?.id === "images" ? s.pop : null));
  const presets = useStore((s) => s.imagePresets);
  const chosen = useStore(chosenImage);
  const gpu = useStore((s) => s.gpu);
  const phone = useMedia(PHONE), cpu = noGpu(gpu);
  const [family, setFamily] = useState<string | "all">("all");
  const [highlight, setHighlight] = useState<string | null>(null);
  const [step, setStep] = useState<"models" | "sizes">("models");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const listed = presets === undefined || presets === NA ? [] : presets.presets;
  const families = [...new Set(listed.map((p) => p.family))];
  const rail = families.length > 1;
  const rows = listed.filter((p) => family === "all" || p.family === family);
  const active = rows.find((p) => p.id === highlight) ?? rows.find((p) => p.id === chosen?.preset.id) ?? rows[0];
  const width = chosen?.width ?? 0, height = chosen?.height ?? 0;

  // the list is ComfyUI's: read it again each time the picker opens
  useEffect(() => { if (pop !== null) void loadImagePresets(); }, [pop !== null]);
  useLayoutEffect(() => {
    if (pop === null) return;
    if (isTouch() && !pop.kb) ref.current?.querySelector<HTMLButtonElement>(".pk-close")?.focus({ preventScroll: true });
    else (ref.current?.querySelector<HTMLButtonElement>(".pk-r.sel .pk-select") ?? ref.current?.querySelector<HTMLButtonElement>(".pk-select"))?.focus({ preventScroll: true });
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
      const failed = await updateSettings({ imageChoice: choice });
      setSaving(false);
      if (failed !== null) { setError(failed); return; }
    }
    closeTip(); closePop(); focusComposer();
  }
  function choose(preset: ImagePreset) {
    setHighlight(preset.id);
    if (phone) { setStep("sizes"); requestAnimationFrame(() => ref.current?.querySelector<HTMLButtonElement>(".pk-back")?.focus({ preventScroll: true })); return; }
    const size = sizeFor(preset, width, height);
    void pick({ preset: preset.id, width: size.width, height: size.height });
  }
  function back() {
    setStep("models");
    requestAnimationFrame(() => ref.current?.querySelector<HTMLButtonElement>(".pk-r.hl .pk-select, .pk-select")?.focus({ preventScroll: true }));
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

  if (pop === null) return null;
  const free = gpu && gpu !== NA ? gpu.freeBytes : undefined;
  const empty = presets === undefined ? "Reading the image models…"
    : presets === NA ? "Image models are not available in this build."
    : presets.readAt === undefined ? "Image models show here once ComfyUI has run."
    : "ComfyUI has none of the files these image models load.";
  return <div ref={ref} id="imagePicker" className={`model-picker image-picker open${step === "sizes" ? " step-context" : ""}`} role="dialog" aria-label="Choose an image model" aria-modal={phone} aria-busy={saving || undefined} onKeyDown={keys}>
    <div className={`pk-layout${rail ? "" : " no-rail"}`}>
      {rail ? <nav className="pk-rail" aria-label="Image model families" inert={phone && step === "sizes"}>
        <button className="pk-fam" aria-label="All image models" aria-pressed={family === "all"} onClick={() => { setFamily("all"); setHighlight(null); }}><Icon id="image" /></button>
        <span className="pk-rail-line" />
        {families.map((f) => <button key={f} className="pk-fam" aria-label={familyName(f)} aria-pressed={family === f} onClick={() => { setFamily(f); setHighlight(null); }}><ImageMark family={f} /></button>)}
      </nav> : null}
      <div className="pk-main">
        {/* where the chat picker's search sits: the column's name, level with Size, and a phone's Close */}
        <div className="pk-search"><span className="pk-title">Image model</span><button className="pk-close" aria-label="Close" onClick={() => closePop(true)}><Icon id="x" /></button></div>
        <div className="pk-list-scroll">
          <div role="listbox" aria-label="Image models" onKeyDown={listKeys}>
            {rows.map((p) => {
              const size = sizeFor(p, width, height), fit = imageFit(size.bytes, gpu);
              return <div key={p.id} className={`pk-r${p.id === chosen?.preset.id ? " sel" : ""}${p.id === active?.id ? " hl" : ""}`} role="option" aria-selected={p.id === chosen?.preset.id} data-preset={p.id} onMouseMove={() => setHighlight(p.id)}>
                <button type="button" className="pk-select" tabIndex={p.id === (chosen?.preset.id ?? rows[0]?.id) ? 0 : -1} aria-label={p.name} onClick={() => choose(p)}>
                  <ImageMark family={p.family} />
                  <span className="pk-name"><span className="pk-nm">{p.name}</span>{p.id === chosen?.preset.id ? <Icon id="check" cls="s12" /> : null}</span>
                  <span className={`pk-v ${fit?.v.k === "no" ? "no" : ""}`}>{gb(size.bytes)}</span>
                </button>
              </div>;
            })}
            {rows.length === 0 ? <div className="pk-empty">{empty}</div> : null}
          </div>
        </div>
      </div>
      <section className="pk-context" aria-label="Size">
        <header className="pk-context-head"><button className="pk-back" aria-label="Back to image models" onClick={back}><Icon id="left" /></button><span>Size</span></header>
        <div className="pk-context-rows" role="radiogroup" aria-label="Size" onKeyDown={(e) => {
          if (e.key === "ArrowLeft") { e.preventDefault(); back(); return; }
          if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
          e.preventDefault();
          const buttons = [...e.currentTarget.querySelectorAll<HTMLButtonElement>("button")], i = buttons.findIndex((b) => b === document.activeElement);
          buttons[(i + (e.key === "ArrowDown" ? 1 : -1) + buttons.length) % buttons.length]?.focus();
        }}>
          {active?.sizes.map((z) => {
            const on = active.id === chosen?.preset.id && z.width === width && z.height === height;
            const fit = imageFit(z.bytes, gpu);
            return <button key={`${z.width}x${z.height}`} className="pk-ctx-row" role="radio" aria-checked={on} tabIndex={on ? 0 : -1} data-size={`${z.width}x${z.height}`} onClick={() => void pick({ preset: active.id, width: z.width, height: z.height })}>
              <span>{sizeLabel(z.width, z.height)}</span>
              {fit === undefined ? <span className="pk-cost pending">{gb(z.bytes)}</span> : <ContextMemory v={fit.v} cpu={cpu} frees={fit.frees} />}
              <span className="pk-context-check">{on ? <Icon id="check" cls="s12" /> : null}</span>
            </button>;
          })}
        </div>
        {error === null ? null : <p className="pk-help pk-choice" role="status">{error}</p>}
      </section>
    </div>
    <footer className="pk-bottom"><span /><span>{cpu ? "Runs in system memory" : free === undefined ? "GPU reading unavailable" : `${gb(free)} free · ${gb(Math.max(0, free - MARGIN))} usable`}</span></footer>
  </div>;
}
