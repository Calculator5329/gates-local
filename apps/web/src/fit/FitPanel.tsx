import type { ReactNode } from "react";
import type { FitReport, GpuOccupant, GpuStatus } from "@gates-local/contracts";
import { NO_GPU_TEXT, type SlowReason, type Verdict, cardGb, decodeSpeed, describeModel, gb, holderName, k, noGpu, slowReason, verdictOf } from "../lib/words/format.ts";
import { Icon } from "../lib/ui/icons.tsx";
import { cardFit, fitFor } from "./fit-table.ts";
import { tpsText } from "../models/model-speed.tsx";
import { measureOf } from "../measure/measures.ts";
import { NA, type State, chatReady, setState, useStore } from "../lib/store/store.ts";
import { Status } from "../lib/ui/settings-controls.tsx";
import { Row } from "../lib/ui/settings-ui.tsx";
import { FitSkel } from "../lib/ui/ui.tsx";
export { openFit } from "./fit-actions.ts";
import { FIT_DOT } from "../models/models-rules.ts";
import { SlowLine } from "../models/MemoryMark.tsx";

const gpuHead = (gpu: GpuStatus | undefined): string =>
  gpu === undefined ? "" : gpu.vendor === "none" ? gpu.detail ? "NVIDIA GPU unavailable" : "No supported GPU" : gpu.totalBytes ? `${shortGpu(gpu.name)} · ${cardGb(gpu.totalBytes)}` : shortGpu(gpu.name);

const GPU_UNREADABLE_TEXT = "GPU memory could not be read. Try again before loading a model.";

const r1 = (bytes: number) => Math.round((bytes / 1024 ** 3) * 10) / 10;

export function shortGpu(name: string | undefined): string {
  return (name ?? "GPU").replace(/^NVIDIA\s+/i, "").replace(/^GeForce\s+/i, "");
}

function occName(o: GpuOccupant): { nm: string; small: string } {
  const nm = holderName(o);
  switch (o.kind) {
    case "chat-model":
      return { nm, small: "chat model" };
    case "whisper":
      return { nm, small: "speech-to-text" };
    case "image":
      return { nm, small: "image generation" };
    case "other-app":
      return { nm, small: "other app" };
    case "unknown":
      return { nm, small: "" };
    default:
      return { nm: o.label, small: /^other$/i.test(o.label) ? "" : "other" };
  }
}

// why: two swatches alternate so neighbouring segments differ
const swOf = (o: GpuOccupant, i: number) => (o.kind === "whisper" ? "sw-whisper" : i % 2 === 0 ? "sw-occ" : "sw-other");
const occupantKey = (o: GpuOccupant) => JSON.stringify([o.kind, o.label, o.protected]);

function MemoryBar({ gpu, name, loaded }: { gpu: GpuStatus; name: string; loaded: boolean }) {
  const tot = r1(gpu.totalBytes ?? 0);
  if (tot <= 0) return null;
  // why: every segment is what the card reading measured; this model is the one drawn as the chat
  const own = loaded ? gpu.occupants.find((o) => o.kind === "chat-model" && o.label === name) : undefined;
  const occ = gpu.occupants.filter((o) => o !== own);
  const counts = new Map<string, number>();
  const parts = occ.map(o => {
    const identity = occupantKey(o), n = counts.get(identity) ?? 0;
    counts.set(identity, n + 1);
    return { o, gb: r1(o.bytes), key: `${identity}:${n}` };
  });
  const used = parts.reduce((a, p) => a + p.gb, 0);
  const ch = own === undefined ? 0 : r1(own.bytes);
  const un = gpu.freeBytes === undefined ? Math.max(0, Math.round((tot - used - ch) * 10) / 10) : r1(gpu.freeBytes);
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
        <span>{cardGb(gpu.totalBytes ?? 0)}</span>
      </div>
      <div className="legend">
        {parts.map((p, i) => {
          const n = occName(p.o);
          return (
            <div key={p.key} className="lg-r">
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

// why: the newest reply in any chat, so the numbers are from the model's last load
function speedOf(s: State, model: string): { ttft: number; tps: number | null } | null {
  let best: { at: number; ttft: number; tps: number | null } | null = null;
  for (const msgs of Object.values(s.messages)) {
    for (let i = msgs.length - 1; i >= 0; i--) {
      const m = msgs[i];
      if (m?.role !== "assistant" || m.model !== model) continue;
      const first = m.times?.firstTokenAt;
      if (first === undefined || m.times === undefined) continue;
      if (best === null || m.times.startedAt > best.at) best = { at: m.times.startedAt, ttft: first - m.times.startedAt, tps: decodeSpeed(m.stats) ?? null };
      break;
    }
  }
  return best === null ? null : { ttft: best.ttft, tps: best.tps };
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

// why: on a card reading freeVramBytes is the whole card, so it is named as every line names it
function Numbers({ r, v, name, gpu, loaded, slow }: { r: FitReport; v: Verdict; name: string; gpu: GpuStatus | undefined; loaded: boolean; slow?: SlowReason | undefined }) {
  const ctx = k(r.numCtx);
  if (v.k === "no") {
    const sys = gpu ? ` plus ${gb(gpu.systemMemoryAvailableBytes)} of system memory` : "";
    return (
      <div className="fp-n fp-numbers">
        <span className="fp-who">{name}</span> needs an estimated {gb(r.needVramBytes)}. The GPU has {cardGb(r.freeVramBytes)} for a model{sys}.
      </div>
    );
  }
  return (
    <div className="fp-n fp-numbers">
      Estimated {gb(r.needVramBytes)}{noGpu(gpu) ? `; ${gpu?.detail ? gpuHead(gpu) : "no supported GPU"}` : ` of a ${cardGb(r.freeVramBytes)} GPU`}.
      <br />
      {v.k === "spill" ? `${gb(v.amt)} in system memory; slower replies.` : slow !== undefined ? <span data-testid="models.fit-panel.slow-now">{slow.sentence}</span> : noGpu(gpu) && r.words?.word !== "Runs on GPU" ? "Runs in system memory." : "Runs entirely on the GPU."}
      <br />
      {r.source === "measured" ? (loaded ? `Measured ${gb(r.needVramBytes)} on last load.` : "Measured at this context.") : `Not measured at ${ctx} yet.`}
    </div>
  );
}

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
        <MemoryBar gpu={gpu} name={name} loaded={loaded} />
      )}
      {v.k === "no" ? null : <Speed model={model} name={name} numCtx={numCtx} loaded={loaded} />}
    </>
  );
}

function FitLine({ r, size }: { r: FitReport; size: number }) {
  const v = verdictOf(r);
  const at = `at ${k(size)}`;
  return (
    <div className="fp-v">
      {v.k === "no" ? (
        <Status dot={FIT_DOT.refuse}>{`Needs ${gb(v.amt)} more ${at}`}</Status>
      ) : (
        <>
          <Status dot={FIT_DOT[r.verdict]}>{v.label}</Status>
          <span style={{ color: "var(--muted-foreground)" }}>{at}</span>
        </>
      )}
    </div>
  );
}

function useFitModel(model: string) {
  const numCtx = useStore((s) => s.numCtx);
  const gpuRaw = useStore((s) => s.gpu);
  const catalog = useStore((s) => (s.catalog === NA ? undefined : s.catalog));
  const load = useStore((s) => s.loads[model]);
  const max = useStore((s) => s.models?.find((m) => m.name === model)?.maxContext);
  const ctx = max === undefined ? numCtx : Math.min(numCtx, max);
  const gpu = gpuRaw === NA ? undefined : gpuRaw;
  return { ctx, gpuRaw, gpu, name: describeModel(model, catalog).name, loaded: load?.state === "ready" && load.numCtx === ctx };
}

function SettingsBody({ model, title, head, action }: { model: string; title: string; head: string; action: ReactNode }) {
  const { ctx, gpuRaw, gpu, name, loaded } = useFitModel(model);
  const table = useStore((s) => s.fitTable);
  const cpu = noGpu(gpu);
  const gpuNotice = gpu?.vendor === "unreadable" ? gpu.detail ?? GPU_UNREADABLE_TEXT : gpu?.vendor === "none" ? gpu.detail ?? NO_GPU_TEXT : undefined;
  const memory = cpu ? "memory" : "GPU memory";
  const fit = gpuRaw === undefined ? undefined : cardFit(fitFor(table, model, ctx));
  const tps = useStore((s) => tpsText(measureOf(s, model)?.tokensPerSecond));
  const slow = slowReason(fit?.slowNow, tps);
  return (
    <>
      {gpuNotice === undefined ? null : <div className="fp-n fp-note">{gpuNotice}</div>}
      <Row label={title} {...(gpuNotice === undefined && head !== "" ? { desc: head } : {})}>
        {fit === undefined ? gpu?.vendor === "unreadable" ? null : table && gpuRaw !== undefined ? <span className="fp-n">{`No ${memory} reading for ${name}.`}</span> : <span className="fp-n" aria-busy="true"><FitSkel w="120px" /></span> : <FitLine r={fit} size={ctx} />}
        {action}
      </Row>
      {cpu ? null : <SlowLine fit={fit} tps={tps} tip={false} testId="models.fit-panel.slow-line" />}
      {fit === undefined ? null : (
        <details className="upd-more fp-more">
          <summary data-testid="models.fit-panel.details">
            <Icon id="right" cls="s14" />
            Details
          </summary>
          <Numbers r={fit} v={verdictOf(fit)} name={name} gpu={gpu} loaded={loaded} slow={slow} />
          <Breakdown model={model} name={name} numCtx={ctx} gpuRaw={gpuRaw} report={fit} loaded={loaded} />
        </details>
      )}
    </>
  );
}

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
      <button type="button" className="qa" data-testid="models.fit-panel.show-model" onClick={() => setState({ fitPanel: { model: null } })}>
        Show {describeModel(chat, catalog).name}
      </button>
    ) : null;
  return (
    <div className="fp-set" id="gpuMemory">
      {!ready ? <div className="fp-n">GPU memory is checked once Ollama is ready.</div> : model === undefined ? <div className="fp-n">Download a model to see how it fits.</div> : <SettingsBody model={model} title={describeModel(model, catalog).name} head={head} action={action} />}
    </div>
  );
}
