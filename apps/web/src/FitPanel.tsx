// The docked GPU memory panel (shell.md F16, F17b, F36, F48, F63): the verdict
// for a model at a context, the context control, and where the memory goes,
// from fit.check plus gpu.status when the server has it.
import { useEffect } from "react";
import type { ContextSize, FitReport, GpuOccupant, GpuStatus } from "@gates-local/contracts";
import { CONTEXT_SIZES, NO_GPU_TEXT, type Verdict, decodeSpeed, describeModel, gb, k, noGpu, otherCtxWords, verdictOf } from "./format.ts";
import { Icon } from "./icons.tsx";
import { ensureFit, setContext, updateSettings } from "./session.ts";
import { NA, type State, chatReady, fitKey, getState, setState, useStore } from "./store.ts";
import { VLabel, closeTip, esc } from "./ui.tsx";

/** Open the panel for a model (null: the chat's own model). It needs a ready runtime. */
export function openFit(model?: string): void {
  const s = getState();
  closeTip();
  if (!chatReady(s)) return;
  setState({ pop: null, fitPanel: { open: true, model: model !== undefined && model !== s.model ? model : null } });
}

export function closeFit(focusChip: boolean): void {
  if (!getState().fitPanel.open) return;
  closeTip();
  setState({ fitPanel: { open: false, model: null } });
  if (focusChip && getState().view !== "settings") document.getElementById("fitBtn")?.focus();
}

const r1 = (bytes: number) => Math.round((bytes / 1024 ** 3) * 10) / 10;
const otherCtx = (c: ContextSize): ContextSize => (c === 65536 ? 32768 : c === 32768 ? 65536 : c === 8192 ? 16384 : 32768);

/** "NVIDIA GeForce RTX 5070 Ti" → "RTX 5070 Ti". */
export function shortGpu(name: string | undefined): string {
  return (name ?? "GPU").replace(/^NVIDIA\s+/i, "").replace(/^GeForce\s+/i, "");
}

/** The line under every context control (F36b): what the other size would do. */
export function ctxLine(cur: FitReport | undefined, other: FitReport | undefined, otherNumCtx: number): { lead: string; alt: string | null } {
  const lead = "How much conversation the model can keep in view.";
  if (!cur || !other) return { lead, alt: null };
  return { lead, alt: `At ${k(otherNumCtx)}:|${otherCtxWords(cur, other)}.` };
}

export function CtxLine({ model, numCtx }: { model: string; numCtx: ContextSize }) {
  const other = otherCtx(numCtx);
  const cur = useStore((s) => s.fits[fitKey(model, numCtx)]);
  const alt = useStore((s) => s.fits[fitKey(model, other)]);
  const max = useStore((s) => s.models?.find((m) => m.name === model)?.maxContext);
  const canOther = max === undefined || other <= max;
  useEffect(() => {
    if (canOther) ensureFit(model, other);
  }, [model, other, alt, canOther]);
  const line = ctxLine(cur === "error" ? undefined : cur, alt === "error" || !canOther ? undefined : alt, other);
  const [lbl, rest] = line.alt?.split("|") ?? [];
  const clamped = max !== undefined && numCtx > max;
  // F76: the definition and the other size's result are separate lines; the scope is the row label above.
  return (
    <>
      <span className="ctx-def">{line.lead}</span>
      {clamped ? <span className="ctx-alt">Runs at {k(max)}, the most this model takes.</span> : null}
      {lbl !== undefined ? (
        <span className="ctx-alt">
          <span className="ctx-k">{lbl}</span> {rest}
        </span>
      ) : null}
    </>
  );
}

function occName(o: GpuOccupant): { nm: string; small: string; tip: string } {
  switch (o.kind) {
    case "whisper":
      return { nm: "Whisper", small: "speech-to-text", tip: "<b>Whisper</b> keeps this memory. Gates Local measures it and never stops it." };
    case "image":
      return { nm: o.label, small: "image generation", tip: `<b>${esc(o.label)}</b> holds this memory for image generation.` };
    case "other-app":
      return { nm: o.label, small: "other app", tip: "<b>Another app</b> holds this memory right now. Measured, never stopped." };
    default:
      return { nm: o.label, small: "other", tip: `<b>${esc(o.label)}</b> holds this memory right now. Measured, never stopped.` };
  }
}

function andList(xs: readonly string[]): string {
  return xs.length <= 1 ? (xs[0] ?? "") : `${xs.slice(0, -1).join(", ")} and ${xs.at(-1) ?? ""}`;
}

/** Who holds memory a chat model cannot use, in the design's sentence (F63). */
function holders(occ: readonly GpuOccupant[]): string | null {
  const held = occ.filter((o) => o.protected && o.kind !== "chat-model");
  if (held.length === 0) return null;
  const names = held.map((o) => occName(o).nm);
  const total = held.reduce((a, o) => a + r1(o.bytes), 0).toFixed(1);
  if (held.length === 1) return `${names[0] ?? ""} holds ${total} GB. Closing it makes room; Gates Local never stops it.`;
  return `${andList(names)} hold ${total} GB. Closing ${held.length === 2 ? "both" : "them"} makes room; Gates Local never stops them.`;
}

const swOf = (o: GpuOccupant) => (o.kind === "whisper" ? "sw-whisper" : "sw-occ");

function MemoryBar({ gpu, name, v, loaded, numCtx }: { gpu: GpuStatus; name: string; v: Verdict; loaded: boolean; numCtx: number }) {
  const tot = r1(gpu.totalBytes ?? 0);
  if (tot <= 0) return null;
  const occ = gpu.occupants.filter((o) => o.kind !== "chat-model");
  const parts = occ.map((o) => ({ o, gb: r1(o.bytes) }));
  const used = parts.reduce((a, p) => a + p.gb, 0);
  const ch = v.k === "no" ? 0 : Math.min(r1(v.need), Math.max(0, Math.round((tot - used) * 10) / 10));
  const un = Math.max(0, Math.round((tot - used - ch) * 10) / 10);
  const w = (x: number) => `${((x / tot) * 100).toFixed(2)}%`;
  return (
    <>
      <div className="bar">
        {parts.map((p, i) => (
          <i key={i} className={swOf(p.o)} style={{ width: w(p.gb) }} />
        ))}
        {ch > 0 ? <i className="sw-chat" style={{ width: w(ch) }} /> : null}
        {un > 0 ? <i className="sw-free" /> : null}
      </div>
      <div className="axis">
        <span>0</span>
        <span>{gb(gpu.totalBytes ?? 0)}</span>
      </div>
      <div className="legend">
        {parts.map((p, i) => {
          const n = occName(p.o);
          return (
            <div key={i} className="lg-r" data-tip={n.tip}>
              <span className={`chip ${swOf(p.o)}`} />
              <span className="nm">
                {n.nm}
                {p.o.protected ? <Icon id="lock" /> : null}
                <small>{n.small}</small>
              </span>
              <span className="v">{p.gb.toFixed(1)} GB</span>
            </div>
          );
        })}
        {ch > 0 ? (
          <div className="lg-r">
            <span className="chip sw-chat" />
            <span className="nm">
              {name}
              <small>{loaded ? "loaded" : `est. at ${k(numCtx)}`}</small>
            </span>
            <span className={`v${loaded ? "" : " est"}`}>{ch.toFixed(1)} GB</span>
          </div>
        ) : null}
        {un > 0 ? (
          <div className="lg-r">
            <span className="chip sw-free" />
            <span className="nm">
              {loaded ? "Currently free" : "Free after loading"}
              {loaded ? null : <small>est.</small>}
            </span>
            <span className="v">{un.toFixed(1)} GB</span>
          </div>
        ) : null}
      </div>
    </>
  );
}

/** First-token time and speed of the latest reply by this model this session, if any. */
function speedOf(s: State, model: string): { ttft: number; tps: number | null } | null {
  for (const msgs of Object.values(s.messages)) {
    for (let i = msgs.length - 1; i >= 0; i--) {
      const m = msgs[i];
      if (m?.role !== "assistant" || m.model !== model) continue;
      const ft = s.firstToken[m.id];
      if (ft === undefined) continue;
      // Decode time only: the total includes loading the model and reading the prompt.
      return { ttft: ft, tps: decodeSpeed(m.stats) ?? null };
    }
  }
  return null;
}

function Speed({ model, name, numCtx, loaded }: { model: string; name: string; numCtx: number; loaded: boolean }) {
  const ttft = useStore((s) => speedOf(s, model)?.ttft);
  const tps = useStore((s) => speedOf(s, model)?.tps ?? null);
  return (
    <>
      <div className="fp-sep" />
      <div className="fp-mt">{loaded ? "Measured on last load" : "Speed"}</div>
      {ttft !== undefined ? (
        <div className="meas">
          <div>
            <b>{(ttft / 1000).toFixed(1)} s</b>
            <span>first token</span>
          </div>
          {tps !== null ? (
            <div>
              <b>{tps} tok/s</b>
              <span>generation</span>
            </div>
          ) : null}
        </div>
      ) : (
        <div className="fp-n" style={{ margin: 0 }}>
          Not measured yet. Gates Local measures it the first time {name} loads at {k(numCtx)}.
        </div>
      )}
    </>
  );
}

function Numbers({ r, v, name, gpu, loaded }: { r: FitReport; v: Verdict; name: string; gpu: GpuStatus | undefined; loaded: boolean }) {
  const ctx = k(r.numCtx);
  if (v.k === "no") {
    const sys = gpu ? ` plus ${gb(gpu.systemMemoryAvailableBytes)} of system memory` : "";
    const who = gpu && gpu.vendor === "nvidia" ? holders(gpu.occupants) : null;
    return (
      <>
        <div className="fp-n">
          <span className="fp-who">{name}</span> needs an estimated {gb(r.needVramBytes)}. {gb(r.freeVramBytes)} of GPU memory is available to this model{sys}.
        </div>
        {who ? <div className="fp-n">{who}</div> : null}
      </>
    );
  }
  if (v.k === "spill") {
    return (
      <div className="fp-n">
        Estimated {gb(r.needVramBytes)}; {noGpu(gpu) ? "no supported GPU" : `${gb(r.freeVramBytes)} of GPU memory is available to this model`} · {r.source === "measured" ? "measured" : `not measured at ${ctx} yet`}
        <br />
        An estimated {gb(v.amt)} runs from system memory, so replies are slower.
      </div>
    );
  }
  return (
    <div className="fp-n">
      Estimated {gb(r.needVramBytes)} of {gb(r.freeVramBytes)} available to this model · {loaded && r.source === "measured" ? `measured ${gb(r.needVramBytes)} on last load` : `not measured at ${ctx} yet`}
    </div>
  );
}

function Body({ model }: { model: string }) {
  const numCtx = useStore((s) => s.numCtx);
  const inSettings = useStore((s) => s.view === "settings");
  const report = useStore((s) => s.fits[fitKey(model, numCtx)]);
  const gpuRaw = useStore((s) => s.gpu);
  const catalog = useStore((s) => (s.catalog === NA ? undefined : s.catalog));
  const load = useStore((s) => s.loads[model]);
  const max = useStore((s) => s.models?.find((m) => m.name === model)?.maxContext);
  const ctx = max === undefined ? numCtx : Math.min(numCtx, max);
  useEffect(() => ensureFit(model, numCtx), [model, numCtx, report]);
  const gpu = gpuRaw === NA ? undefined : gpuRaw;
  const name = describeModel(model, catalog).name;
  const loaded = load?.state === "ready" && load.numCtx === ctx;
  const pickCtx = (c: ContextSize) => {
    closeTip();
    setContext(c);
    if (inSettings) void updateSettings({ defaultNumCtx: c });
  };
  if (report === undefined) return <div className="fp-n">Checking GPU memory…</div>;
  if (report === "error") return <div className="fp-n">Gates Local couldn't check GPU memory for {name} right now.</div>;
  const v = verdictOf(report);
  return (
    <>
      <div className="fp-v">
        {v.k === "no" ? (
          <span className="vl no">
            <span className="vd no" />
            {`Needs ${gb(v.amt)} more at ${k(ctx)}`}
          </span>
        ) : (
          <>
            <VLabel v={v} />
            <span style={{ color: "var(--muted-foreground)" }}>at {k(ctx)}</span>
          </>
        )}
      </div>
      <Numbers r={report} v={v} name={name} gpu={gpu} loaded={loaded} />
      <div className="fp-sep" />
      <div className="fp-row">
        <span className="k">{inSettings ? "Default context" : "Context for this chat"}</span>
        <span className="mini-seg">
          {CONTEXT_SIZES.map((c) => (
            <button key={c} type="button" data-ctx={c} className={ctx === c ? "on" : ""} disabled={max !== undefined && c > max} data-tip={max !== undefined && c > max ? `This model takes at most ${k(max)}.` : undefined} onClick={() => pickCtx(c)}>
              {k(c)}
            </button>
          ))}
        </span>
      </div>
      <div className="ctx-line">
        <CtxLine model={model} numCtx={numCtx} />
      </div>
      <div className="fp-sep" />
      <div className="fp-mt">Where the memory goes</div>
      {gpuRaw === NA ? (
        <div className="na">A breakdown by app is not available in this build.</div>
      ) : gpu === undefined ? (
        <div className="na">Gates Local couldn't read the GPU just now.</div>
      ) : gpu.vendor === "none" ? (
        <div className="fp-n">{NO_GPU_TEXT}</div>
      ) : gpu.vendor === "unreadable" ? (
        <div className="fp-n">Gates Local couldn't read the graphics card{gpu.detail ? ` (${gpu.detail})` : ""}. The estimate above uses system memory only.</div>
      ) : (
        <MemoryBar gpu={gpu} name={name} v={v} loaded={loaded} numCtx={ctx} />
      )}
      {v.k === "no" ? null : <Speed model={model} name={name} numCtx={ctx} loaded={loaded} />}
    </>
  );
}

export function FitPanel() {
  const open = useStore((s) => s.fitPanel.open && s.view !== "firstrun");
  const ready = useStore(chatReady);
  const model = useStore((s) => s.fitPanel.model ?? s.model);
  const gpuRaw = useStore((s) => s.gpu);
  useEffect(() => {
    if (open && !ready) closeFit(false);
  }, [open, ready]);
  if (!open || !ready || model === undefined) return null;
  const gpu = gpuRaw === NA ? undefined : gpuRaw;
  const head = gpu === undefined ? "" : gpu.vendor === "none" ? "No supported GPU" : gpu.totalBytes ? `${shortGpu(gpu.name)} · ${gb(gpu.totalBytes)}` : shortGpu(gpu.name);
  return (
    <aside className="fpanel" id="fitPanel" role="complementary" aria-label={noGpu(gpu) ? "Memory" : "GPU memory"}>
      <div className="fpn-h">
        <div className="fp-h">
          <span className="fp-t">{noGpu(gpu) ? "Memory" : "GPU memory"}</span>
          <span className="fp-gpu">{head}</span>
        </div>
        <button type="button" className="ibtn xs" aria-label="Close" data-tip="Close (Esc)" onClick={() => closeFit(true)}>
          <Icon id="x" cls="s14" />
        </button>
      </div>
      <div className="fpn-b">
        <Body model={model} />
      </div>
    </aside>
  );
}
