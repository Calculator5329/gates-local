// First run (shell.md F32, F43, F44b, F54, F62): one screen before the first
// chat. Found: a recommended installed model and Start chatting. No Ollama: a
// calm status with Retry. No models: download the recommended one, with
// progress and Cancel; the chat can open to draft while it downloads.
import { type ReactNode, useEffect, useState } from "react";
import type { CatalogEntry } from "@gates-local/contracts";
import { ownCopyNote, portOf, rtOf } from "./Banner.tsx";
import { DlDetail } from "./ModelDownloads.tsx";
import { describeModel, gb, k, noGpu, verdictOf } from "./format.ts";
import { Icon } from "./icons.tsx";
import { currentFit, fitPendingWord, fitReading } from "./fit-state.ts";
import { ensureFit, finishFirstRun, firstPull, openSettings, pull, cancelPull, recheckRuntime } from "./session.ts";
import { NA, type State, useStore } from "./store.ts";
import { canChat, chatBlockedReason, chatModels, pickRuleText, pickedModel } from "./pick.ts";
import { focusComposer } from "./Sidebar.tsx";
import { VLabel } from "./ui.tsx";
import { Shell } from "./FirstRunShell.tsx";

function Cta({ label, onGo, link, onLink }: { label: string; onGo: () => void; link?: string; onLink?: () => void }) {
  return (
    <div className="fr-cta">
      <button type="button" className="btn primary lg" onClick={onGo}>
        {label}
        <Icon id="arrow" cls="s14" />
      </button>
      {link ? (
        <button type="button" className="link" onClick={onLink}>
          {link}
        </button>
      ) : null}
    </div>
  );
}

/** Leave first run for a new thread with the cursor in the message box. */
function startChat(): void {
  finishFirstRun("chat");
  focusComposer();
}

const CTX_TIP ="How much of the conversation the model keeps in view. Bigger needs more GPU memory.";

/** The recommended model card: name, verdict, purpose, and a Details disclosure. */
function RecCard({ tag, have, entry, children }: { tag: string; have: boolean; entry?: CatalogEntry | undefined; children?: ReactNode }) {
  const [open, setOpen] = useState(false);
  const numCtx = useStore((s) => s.numCtx);
  const catalog = useStore((s) => (s.catalog === NA ? undefined : s.catalog));
  const info = useStore((s) => s.models?.find((m) => m.name === tag));
  const fits = useStore(s => s.fits);
  const fitStatus = useStore(s => s.fitStatus);
  const fitHistory = useStore(s => s.fitHistory);
  const reading = fitReading({ fits, fitStatus, fitHistory, catalog }, tag, numCtx);
  const cpu = useStore((s) => noGpu(s.gpu));
  const ctx = info?.maxContext === undefined ? numCtx : Math.min(numCtx, info.maxContext);
  useEffect(() => ensureFit(tag, numCtx), [tag, numCtx, fits]);
  const fit = reading.report;
  const v = fit && reading.phase === "fresh" ? verdictOf(fit) : undefined;
  const d = describeModel(tag, catalog);
  const tip = reading.phase !== "fresh" ? "Suggested model. Current memory is being checked." : have ? pickRuleText(numCtx, cpu) : v?.k === "no" ? "Choose a smaller model or context." : cpu
    ? `The first of Gates Local's recommended models that fits in system memory with room for ${k(numCtx)} of context.`
    : v?.k === "spill" ? foundWords("spills", numCtx).sub
    : `The first of Gates Local's recommended models that runs on your GPU with room for ${k(numCtx)} of context.`;
  return (
    <div className="fr-card">
      <div className="fr-m">
        <span className="nm">{d.name}</span>
        <span className="rec">
          <span className="sep">· </span>
          <span className="tipd" tabIndex={0} data-tip={tip}>
            Recommended
          </span>
        </span>
        {v ? (
          <span className="v">
            <VLabel v={v} />
          </span>
        ) : <span className="v">{fitPendingWord(reading.phase, fit !== undefined)}</span>}
      </div>
      <div className="fr-sub">
        {d.purpose}
        {!have && entry ? ` · ${gb(entry.downloadBytes)} download` : ""}
      </div>
      <button type="button" className="think" aria-expanded={open} onClick={() => setOpen(!open)}>
        <span>Details</span>
        <span className="th-x">
          <Icon id="down" />
        </span>
      </button>
      <div className="think-body">
        <table className="kv">
          <tbody>
            <tr>
              <td>Model</td>
              <td>
                <span className="mono">{tag}</span>
                {info?.parameterSize ? ` · ${info.parameterSize} parameters` : ""}
                {info?.quantization ? ` · ${info.quantization}` : ""}
              </td>
            </tr>
            {have && info ? (
              <tr>
                <td>On disk</td>
                <td>{gb(info.sizeBytes)}</td>
              </tr>
            ) : null}
            <tr>
              <td>
                <span className="tipd" tabIndex={0} data-tip={CTX_TIP}>
                  Context
                </span>
              </td>
              <td>{k(ctx)}</td>
            </tr>
            {fit ? (
              <tr>
                <td>{cpu ? "Memory" : "GPU memory"}</td>
                <td>{reading.phase !== "fresh" ? `Previous check: ${gb(fit.needVramBytes)} needed; ${gb(fit.freeVramBytes)} available.` : cpu ? `Estimated ${gb(fit.needVramBytes)}, all in system memory (no supported GPU)` : `Estimated ${gb(fit.needVramBytes)} of ${gb(fit.freeVramBytes)} available to this model`}</td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>
      {children}
    </div>
  );
}

const rtOfState = (s: State) => rtOf(s);

/** The model to recommend when none is installed: the catalog's first recommended entry. */
function recommendedEntry(s: State): CatalogEntry | undefined {
  if (s.catalog === NA || s.catalog === undefined) return undefined;
  return s.catalog.find((c) => c.recommended && c.fit?.verdict !== "refuse") ?? s.catalog.find((c) => c.recommended);
}

function NoModels() {
  const [cancelled, setCancelled] = useState(false);
  const entry = useStore(recommendedEntry);
  const catalogNA = useStore((s) => s.catalog === NA);
  const pullNA = useStore((s) => s.unavailable["models.pull"] === true);
  const active = useStore(firstPull);
  const p = useStore((s) => (active === undefined ? undefined : s.pulls[active]));
  const numCtx = useStore((s) => s.numCtx);
  // Embedding models can be installed and still leave nothing to chat with.
  const others = useStore((s) => (s.models ?? []).length);
  const cpu = useStore((s) => noGpu(s.gpu));
  const fresh = useStore(s => entry === undefined ? undefined : currentFit(s, entry.name, s.numCtx));
  const phase = useStore(s => entry === undefined ? "checking" : fitReading(s, entry.name, s.numCtx).phase);
  const st = (
    <>
      <span className="dot ok" />
      Ollama · {others > 0 ? "no chat models yet" : "no models yet"}
    </>
  );
  // An Ollama that does not report capabilities: a download would not help, so say what would.
  const tooOld = useStore((s) => chatBlockedReason(s.models, undefined));
  const sub =
    tooOld ??
    (fresh === undefined ? `${fitPendingWord(phase, true)} Current memory must be checked before this model can be recommended.` : fresh.verdict === "refuse" ? "Not enough memory at this context. Choose a smaller model or context in Settings." : cpu
      ? `One model is enough. This computer has no supported GPU, so this one runs in system memory with room for ${k(numCtx)} of context. Replies are slower than on a GPU.`
      : fresh.verdict === "spills" ? foundWords("spills", numCtx).sub
      : `One model is enough. This one runs on your GPU with room for ${k(numCtx)} of context.`);
  if (active !== undefined && p !== undefined) {
    return (
      <Shell st={st} title="Downloading your first model" sub={sub}>
        <RecCard tag={active} have={false} entry={entry?.name === active ? entry : undefined}>
          <DlDetail p={p} name={describeModel(active, undefined).name} cancel={false} />
          <div className="prog-l">
            <span />
            <button
              type="button"
              className="qa"
              onClick={() => {
                setCancelled(true);
                void cancelPull(active);
              }}
            >
              Cancel download
            </button>
          </div>
        </RecCard>
        <Cta label="Start chatting" onGo={startChat} />
        <p className="fr-note">You can type now; replies start when the download finishes.</p>
      </Shell>
    );
  }
  if (tooOld !== undefined) {
    // with or without a catalog entry: a downloaded model would be as undescribed as the installed ones
    return (
      <Shell st={st} title="Update Ollama to chat" sub={tooOld}>
        <Cta label="Retry" onGo={() => void recheckRuntime()} />
      </Shell>
    );
  }
  if (entry === undefined || pullNA) {
    // no catalog or no downloads in this build: say how to get a model without the app
    return (
      <Shell st={st} title="Download your first model" sub="Gates Local needs one model to chat.">
        <p className="fr-note na">
          {pullNA || catalogNA ? "Downloading models from here is not available in this build. " : ""}
          Download one with Ollama, for example <span className="mono">ollama pull qwen3.5:9b</span>, then press Retry.
        </p>
        <Cta label="Retry" onGo={() => void recheckRuntime()} />
      </Shell>
    );
  }
  return (
    <Shell st={st} title="Download your first model" sub={sub}>
      <RecCard tag={entry.name} have={false} entry={entry} />
      {cancelled ? (
        <>
          <Cta
            label="Download and start"
            onGo={() => {
              setCancelled(false);
              void pull(entry.name);
            }}
          />
          <p className="fr-note">
            Download cancelled. You can choose another model in{" "}
            <button type="button" className="link" onClick={() => openSettings("models", true)}>
              Settings › Models
            </button>
            .
          </p>
        </>
      ) : (
        <Cta label="Download and start" onGo={() => void pull(entry.name)} link="Choose another model" onLink={() => openSettings("models", true)} />
      )}
    </Shell>
  );
}

/** The selected model's current verdict. A refusal says nothing about the other installed models. */
export function foundWords(verdict: "fits" | "spills" | "refuse" | undefined, numCtx: number, cpu = false, name = "This model"): { title: string; sub: string } {
  if (verdict === "refuse") {
    return { title: "Choose another model", sub: `${name} doesn't fit at ${k(numCtx)}. Choose another model or a smaller context.` };
  }
  // no supported GPU: every model runs in system memory, so no verdict may promise a GPU
  if (cpu) return { title: "Ready to chat", sub: "This computer has no supported GPU, so models run in system memory and replies are slower. Switch models in any chat." };
  if (verdict === "spills") return { title: "Ready to chat", sub: "Your best fit uses system memory, so it is slower." };
  if (verdict === "fits") return { title: "Ready to chat", sub: "Your best GPU fit is ready. Switch models in any chat." };
  return { title: "Ready to chat", sub: "Your best model is ready. Switch models in any chat." };
}

function Found() {
  const count = useStore((s) => chatModels(s.models ?? []).length);
  const picked = useStore((s) => pickedModel(s.models));
  // The composer starts on the same model (session.ts reads the same pick).
  const tag = useStore((s) => s.model ?? picked?.name);
  const catalog = useStore(s => s.catalog === NA ? undefined : s.catalog);
  const name = tag === undefined ? "This model" : describeModel(tag, catalog).name;
  const numCtx = useStore((s) => s.numCtx);
  const cpu = useStore((s) => noGpu(s.gpu));
  const fits = useStore(s => s.fits);
  const fresh = useStore(s => tag === undefined ? undefined : currentFit(s, tag, numCtx));
  const phase = useStore(s => tag === undefined ? "checking" : fitReading(s, tag, numCtx).phase);
  useEffect(() => ensureFit(tag, numCtx), [tag, numCtx, fits]);
  const words = fresh === undefined ? { title: "Checking memory", sub: `${fitPendingWord(phase, true)} Keeping the previous numbers until a current check succeeds.` } : foundWords(fresh.verdict, numCtx, cpu, name);
  return (
    <Shell
      st={
        <>
          <span className={`dot ${fresh?.verdict === "refuse" ? "err" : fresh === undefined ? "run" : "ok"}`} />
          Ollama · {count} chat {count === 1 ? "model" : "models"}
        </>
      }
      title={words.title}
      sub={words.sub}
    >
      {tag !== undefined ? <RecCard tag={tag} have /> : null}
      {fresh?.verdict === "refuse" ? (
        <Cta label="Choose a model" onGo={() => finishFirstRun("models")} link="Start chatting anyway" onLink={startChat} />
      ) : (
        <Cta label="Start chatting" onGo={startChat} link="Change defaults in Settings" onLink={() => finishFirstRun("general")} />
      )}
    </Shell>
  );
}

function NoOllama() {
  const rt = useStore(rtOfState);
  const baseUrl = useStore((s) => s.runtime?.baseUrl);
  const detail = useStore((s) => s.runtime?.detail);
  const note = useStore(ownCopyNote);
  const own = note !== "";
  const around = own ? `${note} ` : "";
  const port = portOf(baseUrl);
  const [title, st, sub] =
    rt === "wrong"
      ? ["Ollama isn't answering", `Port ${port} is busy`, `Something other than Ollama answers on port ${port}.`]
      : rt === "stopped"
        ? ["Ollama is stopped", "Ollama is installed but not running", own ? `${around}It starts when Gates Local opens; press Retry to check again.` : "Start Ollama, then press Retry."]
        : rt === "error"
          ? ["Ollama didn't start", "Ollama reported a problem", (detail ?? "Ollama stopped with an error.")]
          : ["Ollama isn't installed", "No Ollama found on this computer", `${around}Gates Local needs Ollama to chat. Install it from ollama.com, then press Retry.`];
  return (
    <Shell
      st={
        <>
          <span className={`dot ${rt === "error" ? "err" : "warn"}`} />
          {st}
        </>
      }
      title={title}
      sub={sub}
    >
      {rt === "missing" ? <p className="fr-note na">Installing Gates Local's own copy is not available in this build.</p> : null}
      <Cta label="Retry" onGo={() => void recheckRuntime()} link="Settings" onLink={() => finishFirstRun("runtime")} />
    </Shell>
  );
}

function Waiting({ installing }: { installing: boolean }) {
  return (
    <Shell
      st={
        <>
          <span className="dot run" />
          {installing ? "No Ollama found on this computer" : "Looking for Ollama"}
        </>
      }
      title={installing ? "Setting up Ollama" : "Starting up"}
      sub={installing ? "Gates Local is installing its own copy into its app folder. It won't change anything else on your system." : "Checking for Ollama and your models."}
    >
      {installing ? (
        <>
          <Cta label="Start chatting" onGo={startChat} link="Settings" onLink={() => finishFirstRun("general")} />
          <p className="fr-note">You can type now; replies start when setup finishes.</p>
        </>
      ) : null}
    </Shell>
  );
}

export function FirstRun() {
  const rt = useStore(rtOfState);
  const models = useStore((s) => s.models);
  if (rt === "ready" && models !== undefined) return models.some(canChat) ? <Found /> : <NoModels />;
  if (rt === "missing" || rt === "stopped" || rt === "wrong" || rt === "error") return <NoOllama />;
  return <Waiting installing={rt === "installing"} />;
}
