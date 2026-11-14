// GPU memory in Settings › Advanced (shell.md F16, F17b, F36, F48, F63): the
// verdict for a model at a context, the context control, and where the memory
// goes, from the server's fit table plus gpu.status when the server has it.
import { type ReactNode, useState } from "react";
import type { ContextSize, FitReport, GpuOccupant, GpuStatus } from "@gates-local/contracts";
import { CONTEXT_SIZES, NO_GPU_TEXT, type Verdict, decodeSpeed, describeModel, gb, k, noGpu, verdictOf } from "./format.ts";
import { Icon } from "./icons.tsx";
import { cardFit, fitFor } from "./fit-table.ts";
import { setContext, updateSettings } from "./session.ts";
import { NA, type State, chatReady, setState, useStore } from "./store.ts";
import { Status } from "./settings-controls.tsx";
import { Row, useAct } from "./settings-ui.tsx";
import { FitSkel, closeTip, esc } from "./ui.tsx";
export { openFit } from "./fit-actions.ts";
import { FIT_DOT, fitLabel } from "./models-rules.ts";

const gpuHead = (gpu: GpuStatus | undefined): string =>
  gpu === undefined ? "" : gpu.vendor === "none" ? gpu.detail ? "NVIDIA GPU unavailable" : "No supported GPU" : gpu.totalBytes ? `${shortGpu(gpu.name)} · ${gb(gpu.totalBytes)}` : shortGpu(gpu.name);

const GPU_UNREADABLE_TEXT = "GPU memory could not be read. Try again before loading a model.";

const r1 = (bytes: number) => Math.round((bytes / 1024 ** 3) * 10) / 10;

/** "NVIDIA GeForce RTX 5070 Ti" → "RTX 5070 Ti". */
export function shortGpu(name: string | undefined): string {
  return (name ?? "GPU").replace(/^NVIDIA\s+/i, "").replace(/^GeForce\s+/i, "");
}

const runsAtMost = (max: number) => `Runs at ${k(max)}, the most this model takes.`;

/** A context segment's tooltip in Settings, and whether that size cannot run. */
function ctxFit(c: ContextSize, max: number | undefined, r: FitReport | undefined, cpu: boolean): { tip: string | undefined; wont: boolean } {
  if (max !== undefined && c > max) return { tip: `This model takes at most ${k(max)}.`, wont: false };
  if (r === undefined) return { tip: undefined, wont: false };
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

/** A bar segment and its legend swatch: Whisper's gray, and two more so neighbours differ. */
const swOf = (o: GpuOccupant, i: number) => (o.kind === "whisper" ? "sw-whisper" : i % 2 === 0 ? "sw-occ" : "sw-other");
const occupantKey = (o: GpuOccupant) => JSON.stringify([o.kind, o.label, o.protected]);

function MemoryBar({ gpu, name, v, loaded }: { gpu: GpuStatus; name: string; v: Verdict; loaded: boolean }) {
  const tot = r1(gpu.totalBytes ?? 0);
  if (tot <= 0) return null;
  const occ = gpu.occupants.filter((o) => o.kind !== "chat-model");
  const counts = new Map<string, number>();
  const parts = occ.map(o => {
    const identity = occupantKey(o), n = counts.get(identity) ?? 0;
    counts.set(identity, n + 1);
    return { o, gb: r1(o.bytes), key: `${identity}:${n}` };
  });
  const used = parts.reduce((a, p) => a + p.gb, 0);
  // Right now only: the model is drawn while it is loaded, never an estimate cut to what is free.
  const ch = !loaded || v.k === "no" ? 0 : Math.min(r1(v.need), Math.max(0, Math.round((tot - used) * 10) / 10));
  const un = Math.max(0, Math.round((tot - used - ch) * 10) / 10);
  const w = (x: number) => `${((x / tot) * 100).toFixed(2)}%`;
  return (
    <>
      <div className="bar">
        {parts.map((p, i) => (
          <i key={p.key} className={swOf(p.o, i)} style={{ width: w(p.gb) }} />
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
            <div key={p.key} className="lg-r" data-tip={n.tip}>
              <span className={`chip ${swOf(p.o, i)}`} />
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
              <small>loaded</small>
            </span>
            <span className="v">{ch.toFixed(1)} GB</span>
          </div>
        ) : null}
        <div className="lg-r">
          <span className="chip sw-free" />
          <span className="nm">Currently free</span>
          <span className="v">{un.toFixed(1)} GB</span>
        </div>
      </div>
      {occ.some((o) => o.protected) ? <div className="fp-n">A lock means another program holds that memory. Gates Local can't free it.</div> : null}
    </>
  );
}

/** First-token time and speed of the latest reply by this model in the chats loaded here, if any: the server's times on the row. */
function speedOf(s: State, model: string): { ttft: number; tps: number | null } | null {
  for (const msgs of Object.values(s.messages)) {
    for (let i = msgs.length - 1; i >= 0; i--) {
      const m = msgs[i];
      if (m?.role !== "assistant" || m.model !== model) continue;
      const first = m.times?.firstTokenAt;
      if (first === undefined || m.times === undefined) continue;
      const ft = first - m.times.startedAt;
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
      {ttft === undefined ? (
        <div className="fp-n" style={{ margin: 0 }}>
          Speed: not measured yet.<span className="ph-hide"> It shows after {name} replies at {k(numCtx)}.</span>
        </div>
      ) : (
        <>
          <div className="fp-mt">{loaded ? "Measured on last load" : "Speed"}</div>
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
        </>
      )}
    </>
  );
}

// The verdict is against the card's own memory (fit-table cardFit); what other programs hold right
// now is the bar below, never a reason the model won't fit.
function Numbers({ r, v, name, gpu, loaded }: { r: FitReport; v: Verdict; name: string; gpu: GpuStatus | undefined; loaded: boolean }) {
  const ctx = k(r.numCtx);
  if (v.k === "no") {
    const sys = gpu ? ` plus ${gb(gpu.systemMemoryAvailableBytes)} of system memory` : "";
    return (
      <div className="fp-n fp-numbers">
        <span className="fp-who">{name}</span> needs an estimated {gb(r.needVramBytes)}. The GPU has {gb(r.freeVramBytes)} for a model{sys}.
      </div>
    );
  }
  return (
    <div className="fp-n fp-numbers">
      Estimated {gb(r.needVramBytes)}; {noGpu(gpu) ? gpu?.detail ? gpuHead(gpu) : "no supported GPU" : `${gb(r.freeVramBytes)} on the GPU`}.
      <br />
      {v.k === "spill" ? `${gb(v.amt)} in system memory; slower replies.` : "Runs entirely on the GPU."}
      <br />
      {r.source === "measured" ? (loaded ? `Measured ${gb(r.needVramBytes)} on last load.` : "Measured at this context.") : `Not measured at ${ctx} yet.`}
    </div>
  );
}

/** What holds the GPU right now, folded under Details in Settings: information, not the verdict. */
function Breakdown({ model, name, numCtx, gpuRaw, report, loaded }: { model: string; name: string; numCtx: number; gpuRaw: GpuStatus | "na" | undefined; report: FitReport; loaded: boolean }) {
  const gpu = gpuRaw === NA ? undefined : gpuRaw;
  const v = verdictOf(report);
  if (gpuRaw === NA) return v.k === "no" ? null : <Speed model={model} name={name} numCtx={numCtx} loaded={loaded} />;
  if (gpu !== undefined && gpu.vendor !== "nvidia") return v.k === "no" ? null : <Speed model={model} name={name} numCtx={numCtx} loaded={loaded} />;
  return (
    <>
      <div className="fp-sep" />
      <div className="fp-mt">In use right now</div>
      {gpu === undefined ? (
        <div className="na">Gates Local couldn't read the GPU just now.</div>
      ) : (
        <MemoryBar gpu={gpu} name={name} v={v} loaded={loaded} />
      )}
      {v.k === "no" ? null : <Speed model={model} name={name} numCtx={numCtx} loaded={loaded} />}
    </>
  );
}

/** The model's status, in the same words and the same dot as its row in Models. */
/** One verdict. `size` is named only when it is not the one the control above already shows. */
function FitLine({ r, size, cpu }: { r: FitReport; size: number | undefined; cpu: boolean }) {
  const v = verdictOf(r);
  const at = size === undefined ? "" : `at ${k(size)}`;
  return (
    <div className="fp-v">
      {v.k === "no" ? (
        <Status dot={FIT_DOT.refuse}>{`Needs ${gb(v.amt)} more ${at}`.trimEnd()}</Status>
      ) : (
        <>
          <Status dot={FIT_DOT[r.verdict]}>{fitLabel(r.verdict, v.measured, cpu)}</Status>
          {at === "" ? null : <span style={{ color: "var(--muted-foreground)" }}>{at}</span>}
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
 * The one default-context control (S1-06) as a normal row with one short line,
 * each segment's fit in its tooltip; the model's status in its own row beneath,
 * the one place the fit is said, and the GB numbers one step away under Details.
 */
function SettingsBody({ model, title, head, action }: { model: string; title: string; head: string; action: ReactNode }) {
  // the control shows the saved default; this model may run below it
  const saved = useStore((s) => (s.settings === NA ? undefined : s.settings?.defaultNumCtx));
  const chosen = useStore(s => s.model === undefined ? undefined : s.numCtx);
  const { numCtx, max, ctx, gpuRaw, gpu, name, loaded } = useFitModel(model, chosen ?? saved);
  const table = useStore((s) => s.fitTable);
  const settingsNA = useStore((s) => s.settings === NA);
  const locked = useStore((s) => s.unavailable["settings.update"] === true);
  const [err, run] = useAct();
  const cpu = noGpu(gpu);
  const gpuNotice = gpu?.vendor === "unreadable" ? gpu.detail ?? GPU_UNREADABLE_TEXT : gpu?.vendor === "none" ? gpu.detail ?? NO_GPU_TEXT : undefined;
  // A picked size shows at once, while the server saves it (the chat already runs at it). It stays until
  // the server answers: then the saved default is in the store, or it goes back to it with the error.
  const [pending, setPending] = useState<ContextSize | undefined>(undefined);
  const pick = (c: ContextSize) => {
    closeTip();
    setContext(c);
    if (settingsNA) return;
    setPending(c);
    void run(updateSettings({ defaultNumCtx: c })).then(() => setPending((p) => (p === c ? undefined : p)));
  };
  const memory = cpu ? "memory" : "GPU memory";
  // the table's row at the size this model runs at; it says estimate until the model has really run there.
  // Details needs the GPU reading too, so the row waits for it rather than growing when it lands.
  // Judged against the card's own memory (cardFit), whatever other programs hold right now.
  const fit = gpuRaw === undefined ? undefined : cardFit(fitFor(table, model, ctx));
  const defaultSize = pending ?? saved ?? numCtx;
  // The row below carries the verdict; this line is only for a model that cannot take the saved default.
  const limited = max !== undefined && max < CONTEXT_SIZES[CONTEXT_SIZES.length - 1]!;
  const live = max !== undefined && defaultSize > max ? runsAtMost(max) : undefined;
  return (
    <>
      {gpuNotice === undefined ? null : <div className="fp-n fp-note">{gpuNotice}</div>}
      {locked ? null : (
        <Row label="Default context" desc={`Tokens the model keeps in view, in every chat. Longer uses more ${memory}.`} err={err}>
          <div className="ctx-c">
            <span className="mini-seg" role="group" aria-label="Default context">
              {CONTEXT_SIZES.map((c) => {
                const f = ctxFit(c, max, cardFit(fitFor(table, model, c)), cpu);
                return (
                  <button
                    key={c}
                    type="button"
                    data-ctx={c}
                    className={`${defaultSize === c ? "on" : ""}${f.wont ? " dim" : ""}`}
                    aria-pressed={defaultSize === c}
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
            {limited ? <div className="ctx-line">{live}</div> : null}
          </div>
        </Row>
      )}
      <Row label={title} {...(gpuNotice === undefined && head !== "" ? { desc: head } : {})}>
        {fit === undefined ? gpu?.vendor === "unreadable" ? null : table && gpuRaw !== undefined ? <span className="fp-n">{`No ${memory} reading for ${name}.`}</span> : <span className="fp-n" aria-busy="true"><FitSkel w="120px" /></span> : <FitLine r={fit} size={ctx === defaultSize ? undefined : ctx} cpu={cpu} />}
        {action}
      </Row>
      {fit === undefined ? null : (
        <details className="upd-more fp-more">
          <summary>
            <Icon id="right" cls="s14" />
            Details
          </summary>
          <Numbers r={fit} v={verdictOf(fit)} name={name} gpu={gpu} loaded={loaded} />
          <Breakdown model={model} name={name} numCtx={ctx} gpuRaw={gpuRaw} report={fit} loaded={loaded} />
        </details>
      )}
    </>
  );
}

/** GPU memory, the first group of Settings › Advanced, live from the store. */
export function GpuMemory() {
  const ready = useStore(chatReady);
  const chat = useStore((s) => s.model);
  const shown = useStore((s) => s.fitPanel.model);
  const catalog = useStore((s) => (s.catalog === NA ? undefined : s.catalog));
  const gpuRaw = useStore((s) => s.gpu);
  const model = shown ?? chat;
  const head = gpuHead(gpuRaw === NA ? undefined : gpuRaw);
  const action =
    shown !== null && chat !== undefined ? (
      <button type="button" className="qa" onClick={() => setState({ fitPanel: { model: null } })}>
        Show {describeModel(chat, catalog).name}
      </button>
    ) : null;
  return (
    <div className="fp-set" id="gpuMemory">
      {!ready ? <div className="fp-n">GPU memory is checked once Ollama is ready.</div> : model === undefined ? <div className="fp-n">Download a model to see how it fits.</div> : <SettingsBody model={model} title={describeModel(model, catalog).name} head={head} action={action} />}
    </div>
  );
}
