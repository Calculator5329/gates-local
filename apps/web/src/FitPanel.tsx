// GPU memory in Settings › Advanced (shell.md F16, F17b, F36, F48, F63): the
// verdict for a model at a context, the context control, and where the memory
// goes, from fit.check plus gpu.status when the server has it.
import { useEffect, useState } from "react";
import type { ContextSize, FitReport, GpuOccupant, GpuStatus } from "@gates-local/contracts";
import { CONTEXT_SIZES, NO_GPU_TEXT, type Verdict, decodeSpeed, describeModel, gb, k, noGpu, otherCtxWords, verdictOf } from "./format.ts";
import { Icon } from "./icons.tsx";
import { ensureFit, setContext, updateSettings } from "./session.ts";
import { NA, type State, chatReady, fitKey, setState, useStore } from "./store.ts";
import { Fail, useAct } from "./settings-ui.tsx";
import { PHONE, VLabel, closeTip, esc, useMedia } from "./ui.tsx";
import { closeGpuPanel } from "./fit-actions.ts";
export { closeGpuPanel, openFit, openGpuPanel } from "./fit-actions.ts";

const gpuHead = (gpu: GpuStatus | undefined): string =>
  gpu === undefined ? "" : gpu.vendor === "none" ? "No supported GPU" : gpu.totalBytes ? `${shortGpu(gpu.name)} · ${gb(gpu.totalBytes)}` : shortGpu(gpu.name);

/** GPU memory docked beside the chat (thread menu › GPU memory); Settings › Advanced has the same content. */
export function GpuPanel() {
  const open = useStore((s) => s.fitPanel.open && s.view !== "settings" && s.view !== "firstrun");
  const ready = useStore(chatReady);
  const model = useStore((s) => s.fitPanel.model ?? s.model);
  const gpuRaw = useStore((s) => s.gpu);
  useEffect(() => {
    if (open) document.querySelector<HTMLElement>("#fitPanel .fpn-x")?.focus({ preventScroll: true });
  }, [open]);
  if (!open) return null;
  const gpu = gpuRaw === NA ? undefined : gpuRaw;
  const title = noGpu(gpu) ? "System memory" : "GPU memory";
  return (
    <>
    {/* a phone's GPU sheet sits over a scrim; the docked desktop panel draws none */}
    <div className="scrim fp-scrim" aria-hidden="true" onClick={() => closeGpuPanel(true)} />
    <aside className="fpanel" id="fitPanel" aria-label={title}>
      <div className="fpn-h">
        <div className="fp-h">
          <span className="fp-t">{title}</span>
          <span className="fp-gpu">{gpuHead(gpu)}</span>
        </div>
        <button type="button" className="ibtn xs fpn-x" aria-label={noGpu(gpu) ? "Close system memory" : "Close GPU memory"} data-tip="Close (Esc)" onClick={() => closeGpuPanel(true)}>
          <Icon id="x" cls="s14" />
        </button>
      </div>
      <div className="fpn-b">
        {!ready ? <div className="fp-n">GPU memory is checked once Ollama is ready.</div> : model === undefined ? <div className="fp-n">Download a model to see how it fits.</div> : <Body model={model} />}
      </div>
    </aside>
    </>
  );
}

const r1 = (bytes: number) => Math.round((bytes / 1024 ** 3) * 10) / 10;
const otherCtx = (c: ContextSize): ContextSize => (c === 65536 ? 32768 : c === 32768 ? 65536 : c === 8192 ? 16384 : 32768);

/** "NVIDIA GeForce RTX 5070 Ti" → "RTX 5070 Ti". */
export function shortGpu(name: string | undefined): string {
  return (name ?? "GPU").replace(/^NVIDIA\s+/i, "").replace(/^GeForce\s+/i, "");
}

const runsAtMost = (max: number) => `Runs at ${k(max)}, the most this model takes.`;

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
      {clamped ? <span className="ctx-alt">{runsAtMost(max)}</span> : null}
      {lbl !== undefined ? (
        <span className="ctx-alt">
          <span className="ctx-k">{lbl}</span> {rest}
        </span>
      ) : null}
    </>
  );
}

/** A context segment's tooltip in Settings, and whether that size cannot run. */
function ctxFit(c: ContextSize, max: number | undefined, r: FitReport | "error" | undefined, cpu: boolean): { tip: string | undefined; wont: boolean } {
  if (max !== undefined && c > max) return { tip: `This model takes at most ${k(max)}.`, wont: false };
  if (r === undefined || r === "error") return { tip: undefined, wont: false };
  const v = verdictOf(r);
  const at = k(c);
  if (v.k === "gpu") return { tip: `Runs on the GPU at ${at}.`, wont: false };
  if (v.k === "spill") return { tip: cpu ? `Runs in system memory at ${at}.` : `Slower at ${at}: ${gb(v.amt)} runs from system memory.`, wont: false };
  return { tip: `Won't fit at ${at}: needs ${gb(v.amt)} more.`, wont: true };
}

function occName(o: GpuOccupant): { nm: string; small: string; tip: string } {
  switch (o.kind) {
    case "whisper":
      return { nm: "Whisper", small: "speech-to-text", tip: "<b>Whisper</b> keeps this memory. Gates Local measures it and never stops it." };
    case "image":
      return { nm: o.label, small: "image generation", tip: `<b>${esc(o.label)}</b> holds this memory for image generation.` };
    case "other-app":
      return { nm: o.label, small: "other app", tip: "<b>Another app</b> holds this memory right now. Measured, never stopped." };
    case "unknown":
      return { nm: "Other", small: "", tip: "Held by something Gates Local can't name. Measured, never stopped." };
    default:
      return { nm: o.label, small: /^other$/i.test(o.label) ? "" : "other", tip: `<b>${esc(o.label)}</b> holds this memory right now. Measured, never stopped.` };
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
                {n.small === "" ? null : <small>{n.small}</small>}
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
            <span className="v">{ch.toFixed(1)} GB</span>
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
          Not measured yet.<span className="ph-hide"> Gates Local measures it the first time {name} loads at {k(numCtx)}.</span>
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

/** Where the memory goes: the numbers Settings folds under Details and the docked panel shows open. */
function Breakdown({ model, name, numCtx, gpuRaw, report, loaded }: { model: string; name: string; numCtx: number; gpuRaw: GpuStatus | "na" | undefined; report: FitReport; loaded: boolean }) {
  const gpu = gpuRaw === NA ? undefined : gpuRaw;
  const v = verdictOf(report);
  if (gpuRaw === NA) return v.k === "no" ? null : <Speed model={model} name={name} numCtx={numCtx} loaded={loaded} />;
  return (
    <>
      <div className="fp-sep" />
      <div className="fp-mt">Where the memory goes</div>
      {gpu === undefined ? (
        <div className="na">Gates Local couldn't read the GPU just now.</div>
      ) : gpu.vendor === "none" ? (
        <div className="fp-n">{NO_GPU_TEXT}</div>
      ) : gpu.vendor === "unreadable" ? (
        <div className="fp-n">Gates Local couldn't read the graphics card{gpu.detail ? ` (${gpu.detail})` : ""}. The estimate above uses system memory only.</div>
      ) : (
        <MemoryBar gpu={gpu} name={name} v={v} loaded={loaded} numCtx={numCtx} />
      )}
      {v.k === "no" ? null : <Speed model={model} name={name} numCtx={numCtx} loaded={loaded} />}
    </>
  );
}

function FitLine({ v, ctx }: { v: Verdict; ctx: number }) {
  return (
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
  );
}

/**
 * What both bodies read about a model: its size limit, the size it runs at,
 * and the GPU. `chosen` is the size asked for when it is not the open chat's.
 */
function useFitModel(model: string, chosen?: ContextSize) {
  const live = useStore((s) => s.numCtx);
  const numCtx = chosen ?? live;
  const gpuRaw = useStore((s) => s.gpu);
  const catalog = useStore((s) => (s.catalog === NA ? undefined : s.catalog));
  const load = useStore((s) => s.loads[model]);
  const max = useStore((s) => s.models?.find((m) => m.name === model)?.maxContext);
  const ctx = max === undefined ? numCtx : Math.min(numCtx, max);
  const gpu = gpuRaw === NA ? undefined : gpuRaw;
  return { numCtx, max, ctx, gpuRaw, gpu, name: describeModel(model, catalog).name, loaded: load?.state === "ready" && load.numCtx === ctx };
}

/**
 * The one default-context control (S1-06): a line for the size chosen, each
 * segment's fit in its tooltip, and the GB numbers one step away under Details.
 */
function SettingsBody({ model }: { model: string }) {
  // the control shows the saved default; this model may run below it
  const saved = useStore((s) => (s.settings === NA ? undefined : s.settings?.defaultNumCtx));
  const { numCtx, max, ctx, gpuRaw, gpu, name, loaded } = useFitModel(model, saved);
  const fits = useStore((s) => s.fits);
  const settingsNA = useStore((s) => s.settings === NA);
  const [err, run] = useAct();
  useEffect(() => {
    // the report shown is keyed by the size asked for, even one over the model's limit; the server clamps it
    ensureFit(model, numCtx);
    for (const c of CONTEXT_SIZES) if (max === undefined || c <= max) ensureFit(model, c);
  }, [model, numCtx, max, fits]);
  const cpu = noGpu(gpu);
  const report = fits[fitKey(model, numCtx)];
  const pick = (c: ContextSize) => {
    closeTip();
    setContext(c);
    if (!settingsNA) void run(updateSettings({ defaultNumCtx: c }));
  };
  return (
    <>
      {report === undefined ? (
        <div className="fp-n">Checking {cpu ? "memory" : "GPU memory"}…</div>
      ) : report === "error" ? (
        <div className="fp-n">Gates Local couldn't check {cpu ? "memory" : "GPU memory"} for {name} right now.</div>
      ) : (
        <FitLine v={verdictOf(report)} ctx={ctx} />
      )}
      <div className="fp-row fp-ctl">
        <span className="k">Default context</span>
        <span className="mini-seg" role="group" aria-label="Default context">
          {CONTEXT_SIZES.map((c) => {
            const f = ctxFit(c, max, fits[fitKey(model, c)], cpu);
            return (
              <button
                key={c}
                type="button"
                data-ctx={c}
                className={`${numCtx === c ? "on" : ""}${f.wont ? " dim" : ""}`}
                aria-pressed={numCtx === c}
                aria-label={f.wont ? `${k(c)}, won't fit` : undefined}
                disabled={max !== undefined && c > max}
                data-tip={f.tip}
                onClick={() => pick(c)}
              >
                {k(c)}
              </button>
            );
          })}
        </span>
      </div>
      <div className="ctx-line">
        <span className="ctx-def">How much conversation the model can keep in view.</span>
        {max !== undefined && numCtx > max ? <span className="ctx-alt">{runsAtMost(max)}</span> : null}
        <Fail err={err} />
      </div>
      {report === undefined || report === "error" ? null : (
        <details className="upd-more fp-more">
          <summary>Details</summary>
          <Numbers r={report} v={verdictOf(report)} name={name} gpu={gpu} loaded={loaded} />
          <Breakdown model={model} name={name} numCtx={ctx} gpuRaw={gpuRaw} report={report} loaded={loaded} />
        </details>
      )}
    </>
  );
}

function pickChatCtx(c: ContextSize): void {
  closeTip();
  setContext(c);
}

function Body({ model }: { model: string }) {
  const { numCtx, max, ctx, gpuRaw, gpu, name, loaded } = useFitModel(model);
  const report = useStore((s) => s.fits[fitKey(model, numCtx)]);
  // a phone's GPU sheet leads with the verdict and the context; the numbers wait under Details
  const sheet = useMedia(PHONE);
  const [details, setDetails] = useState(false);
  useEffect(() => ensureFit(model, numCtx), [model, numCtx, report]);
  if (report === undefined) return <div className="fp-n">Checking GPU memory…</div>;
  if (report === "error") return <div className="fp-n">Gates Local couldn't check GPU memory for {name} right now.</div>;
  const v = verdictOf(report);
  const verdict = <FitLine v={v} ctx={ctx} />;
  const numbers = <Numbers r={report} v={v} name={name} gpu={gpu} loaded={loaded} />;
  const context = (
    <>
      <div className="fp-row">
        <span className="k">Context for this chat</span>
        <span className="mini-seg" role="group" aria-label="Context for this chat">
          {CONTEXT_SIZES.map((c) => (
            <button key={c} type="button" data-ctx={c} className={ctx === c ? "on" : ""} aria-pressed={ctx === c} disabled={max !== undefined && c > max} data-tip={max !== undefined && c > max ? `This model takes at most ${k(max)}.` : undefined} onClick={() => pickChatCtx(c)}>
              {k(c)}
            </button>
          ))}
        </span>
      </div>
      <div className="ctx-line">
        <CtxLine model={model} numCtx={numCtx} />
      </div>
    </>
  );
  const memory = <Breakdown model={model} name={name} numCtx={ctx} gpuRaw={gpuRaw} report={report} loaded={loaded} />;
  if (sheet) {
    return (
      <>
        {verdict}
        <div className="fp-sep" />
        {context}
        <button type="button" className="think fp-det" aria-expanded={details} onClick={() => setDetails(!details)}>
          <span className="th-l">Details</span>
          <span className="th-x">
            <Icon id="down" />
          </span>
        </button>
        <div hidden={!details}>
          {numbers}
          {memory}
        </div>
      </>
    );
  }
  return (
    <>
      {verdict}
      {numbers}
      <div className="fp-sep" />
      {context}
      {memory}
    </>
  );
}

/** GPU memory, the first group of Settings › Advanced: the same content the docked panel had, live from the store. */
export function GpuMemory() {
  const ready = useStore(chatReady);
  const chat = useStore((s) => s.model);
  const shown = useStore((s) => s.fitPanel.model);
  const catalog = useStore((s) => (s.catalog === NA ? undefined : s.catalog));
  const gpuRaw = useStore((s) => s.gpu);
  const model = shown ?? chat;
  const head = gpuHead(gpuRaw === NA ? undefined : gpuRaw);
  return (
    <div className="fp-set" id="gpuMemory">
      <div className="fp-h">
        <span className="fp-t">{model === undefined ? "No model yet" : describeModel(model, catalog).name}</span>
        <span className="fp-gpu">{head}</span>
        {shown !== null && chat !== undefined ? (
          <button type="button" className="qa" onClick={() => setState((s) => ({ fitPanel: { open: s.fitPanel.open, model: null } }))}>
            Show {describeModel(chat, catalog).name}
          </button>
        ) : null}
      </div>
      {!ready ? <div className="fp-n">GPU memory is checked once Ollama is ready.</div> : model === undefined ? <div className="fp-n">Download a model to see how it fits.</div> : <SettingsBody model={model} />}
    </div>
  );
}
