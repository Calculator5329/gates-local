// First run (shell.md F32, F43, F44b, F54, F62): one screen before the first
// chat. Found: a recommended installed model and Start chatting. No Ollama: a
// calm status with Retry. No models: download the recommended one, with
// progress and Cancel; the chat can open to draft while it downloads.
import { type ReactNode, useEffect, useState } from "react";
import type { CatalogEntry } from "@gates-local/contracts";
import { CONNECTING, booting, ownCopyNote, portOf, rtOf, unread } from "./Banner.tsx";
import { DlDetail, canCancelPull } from "./ModelDownloads.tsx";
import { ctxFor, describeModel, gb, k, noGpu, verdictOf } from "./format.ts";
import { Icon } from "./icons.tsx";
import { type RowPhase, phaseOf, rowOf } from "./fit-table.ts";
import { finishFirstRun, firstPull, openSettings, pull, cancelPull, recheckRuntime } from "./session.ts";
import { NA, type State, useStore } from "./store.ts";
import { canChat, chatBlockedReason, chatModels, pickRuleText, pickedModel } from "./pick.ts";
import { focusComposer } from "./Sidebar.tsx";
import { VLabel } from "./ui.tsx";
import { FirstRunLoading, Shell } from "./FirstRunShell.tsx";

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

/** The card's verdict slot before the table has this model: the table is on its way, or it has no reading for it. */
const pendingWord = (phase: RowPhase): string => (phase === "checking" ? "Checking…" : "Couldn't check");

const CTX_TIP ="How much of the conversation the model keeps in view. Bigger needs more GPU memory.";
const SPILL_TIP = "Your best fit uses system memory, so it is slower.";

/**
 * The recommended model card: name and verdict, a download's size when it is
 * one, and a Details disclosure. The model's purpose phrase is not here: the
 * screen is about whether it runs, and the picker and Settings carry it.
 */
function RecCard({ tag, have, entry, children }: { tag: string; have: boolean; entry?: CatalogEntry | undefined; children?: ReactNode }) {
  const [open, setOpen] = useState(false);
  const numCtx = useStore((s) => s.numCtx);
  const catalog = useStore((s) => (s.catalog === NA ? undefined : s.catalog));
  const info = useStore((s) => s.models?.find((m) => m.name === tag));
  const cpu = useStore((s) => noGpu(s.gpu));
  const ctx = useStore((s) => ctxFor(s.numCtx, s.models, tag));
  const fit = useStore((s) => rowOf(s, tag));
  const phase = useStore((s) => phaseOf(s.fitTable, rowOf(s, tag)));
  const v = fit ? verdictOf(fit) : undefined;
  const d = describeModel(tag, catalog);
  const tip = !v ? "Suggested model." : have ? pickRuleText(numCtx, cpu) : v?.k === "no" ? "Choose a smaller model or context." : cpu
    ? `The first of Gates Local's recommended models that fits in system memory with room for ${k(numCtx)} of context.`
    : v?.k === "spill" ? SPILL_TIP
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
        <span className="v" data-wait="" data-watch="fit">
          {v ? <VLabel v={v} /> : pendingWord(phase)}
        </span>
      </div>
      {!have && entry ? <div className="fr-sub">{gb(entry.downloadBytes)} download</div> : null}
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
                <td>{cpu ? `Estimated ${gb(fit.needVramBytes)}, all in system memory (no supported GPU)` : `Estimated ${gb(fit.needVramBytes)} of ${gb(fit.freeVramBytes)} available to this model`}</td>
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
  return s.catalog.find((c) => c.recommended && rowOf(s, c.name)?.verdict !== "refuse") ?? s.catalog.find((c) => c.recommended);
}

function NoModels() {
  const [cancelled, setCancelled] = useState(false);
  const entry = useStore(recommendedEntry);
  const catalogNA = useStore((s) => s.catalog === NA);
  const pullNA = useStore((s) => s.unavailable["models.pull"] === true);
  const canCancel = useStore(canCancelPull);
  const active = useStore(firstPull);
  const p = useStore((s) => (active === undefined ? undefined : s.pulls[active]));
  // Embedding models can be installed and still leave nothing to chat with.
  const others = useStore((s) => (s.models ?? []).length);
  const cpu = useStore((s) => noGpu(s.gpu));
  const fresh = useStore(s => entry === undefined ? undefined : rowOf(s, entry.name));
  const st = (
    <>
      <span className="dot ok" />
      Ollama · {others > 0 ? "no chat models yet" : "no models yet"}
    </>
  );
  // An Ollama that does not report capabilities: a download would not help, so say what would.
  const tooOld = useStore((s) => chatBlockedReason(s.models, undefined));
  // a sentence only for what the title and the card's verdict do not say: the step, or why it is slower
  const sub =
    tooOld ??
    (fresh === undefined ? undefined : fresh.verdict === "refuse" ? "Not enough memory at this context. Choose a smaller model or context in Settings." : cpu
      ? "This computer has no supported GPU, so this model runs in system memory and replies are slower."
      : undefined);
  if (active !== undefined && p !== undefined) {
    return (
      <Shell st={st} title="Downloading your first model" sub={sub}>
        <RecCard tag={active} have={false} entry={entry?.name === active ? entry : undefined}>
          <DlDetail p={p} name={describeModel(active, undefined).name} cancel={false} />
          {canCancel ? (
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
          ) : null}
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
      <Shell st={st} title={pullNA ? "No model installed yet" : "Download your first model"}>
        <p className="fr-note na">
          {pullNA || catalogNA ? "Gates Local can't download models from here. " : ""}
          On the computer, download one with Ollama, for example <span className="mono">ollama pull qwen3.5:9b</span>, then press Retry.
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

/**
 * The selected model's current verdict. A refusal says nothing about the other
 * installed models. The title and the card's verdict say whether it runs; a
 * sentence is added only for the number a refusal turns on, or for why every
 * reply will be slower.
 */
export function foundWords(verdict: "fits" | "spills" | "refuse" | undefined, numCtx: number, cpu = false, name = "This model"): { title: string; sub?: string } {
  if (verdict === "refuse") return { title: "Choose another model", sub: `${name} doesn't fit at ${k(numCtx)}. A smaller context may fit.` };
  // no supported GPU: every model runs in system memory, so no verdict may promise a GPU
  if (cpu) return { title: "Ready to chat", sub: "This computer has no supported GPU, so models run in system memory and replies are slower." };
  return { title: "Ready to chat" };
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
  const fresh = useStore(s => rowOf(s, tag));
  const phase = useStore(s => phaseOf(s.fitTable, rowOf(s, tag)));
  // no row for it: the title says what the card's slot says (still checking, or the table has no
  // reading for it); no sentence, never "Ready"
  const words = fresh !== undefined ? foundWords(fresh.verdict, numCtx, cpu, name) : { title: phase === "checking" ? "Checking memory" : "Couldn't check memory" };
  const dot = fresh === undefined ? (phase === "checking" ? "run" : "warn") : fresh.verdict === "refuse" ? "err" : "ok";
  return (
    <Shell
      st={
        <>
          <span className={`dot ${dot}`} />
          Ollama · {count} chat {count === 1 ? "model" : "models"}
        </>
      }
      title={words.title}
      sub={words.sub}
      wait
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
  const computerOnly = useStore((s) => s.unavailable["runtime.retry"] === true);
  const own = note !== "";
  const around = own ? `${note} ` : "";
  const port = portOf(baseUrl);
  // the sentence carries the cause or the step; a busy port's status line is its cause, so it has none
  const [title, st, sub]: [string, string, string | undefined] =
    rt === "wrong"
      ? ["Ollama isn't answering", `Something else holds port ${port}`, undefined]
      : rt === "stopped"
        ? ["Ollama is stopped", "Ollama is installed but not running", own ? `${around}It starts when Gates Local opens; press Retry to check again.` : "Start Ollama, then press Retry."]
        : rt === "error"
          ? ["Ollama didn't start", "Ollama reported a problem", detail]
          : ["Ollama isn't installed", "No Ollama found on this computer", `${around}Install Ollama from ollama.com, then press Retry.`];
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
      {rt === "missing" ? <p className="fr-note na">{computerOnly ? "Gates Local can't install Ollama from here. On the computer, install it from ollama.com, then press Retry." : "Installing Gates Local's own copy is not available in this build."}</p> : null}
      {rt === "error" && computerOnly ? <p className="fr-note na">Gates Local can't fix this from here. On the computer, press Retry in Gates Local.</p> : null}
      <Cta label="Retry" onGo={() => void recheckRuntime()} link="Settings" onLink={() => finishFirstRun("runtime")} />
    </Shell>
  );
}

/** Nothing to say yet but that the app is connecting; the dot holds the status line. */
function Connecting() {
  return <Shell st={<span className="dot run" />} title={CONNECTING} />;
}

function Waiting({ installing }: { installing: boolean }) {
  // the runtime has not answered once: no Ollama words yet
  const none = useStore(unread);
  if (none) return <Connecting />;
  return (
    <Shell
      st={
        <>
          <span className="dot run" />
          {installing ? "No Ollama found on this computer" : "Looking for Ollama"}
        </>
      }
      title={installing ? "Setting up Ollama" : "Starting up"}
      sub={installing ? "Gates Local is installing its own copy into its app folder. It won't change anything else on your system." : undefined}
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

/** How long first run waits for its card's words and memory check before it shows with the check still running; the same bound as Settings' reads. */
const WHOLE_WAIT_MS = 1000;

/** The model the screen will be about: the installed pick, else the one it offers to download. */
function screenModel(s: State): string | undefined {
  if (s.models === undefined) return undefined;
  return s.models.some(canChat) ? (s.model ?? pickedModel(s.models)?.name) : recommendedEntry(s)?.name;
}

/** The catalog is read (the card's model name and download size) and the fit table has answered for the model. */
function inHand(s: State): boolean {
  // an Ollama to update, or no way to download here: the words need no catalog and no check
  if (chatBlockedReason(s.models, undefined) !== undefined || s.unavailable["models.pull"] === true) return true;
  if (s.catalog === undefined) return false;
  const tag = screenModel(s);
  if (tag === undefined) return true;
  // the table has this model's row, or it is in and has no reading for it ("Couldn't check")
  return phaseOf(s.fitTable, rowOf(s, tag)) !== "checking";
}

export function FirstRun() {
  const rt = useStore(rtOfState);
  const boot = useStore(booting);
  const models = useStore((s) => s.models);
  const ready = useStore(inHand);
  const known = !boot && rt === "ready" && models !== undefined;
  const [waited, setWaited] = useState(false);
  const [shown, setShown] = useState(false);
  // anything but the placeholders has shown (past the boot bound): they never come back,
  // so until the screen's words are in hand "Connecting…" stays up instead
  const [left, setLeft] = useState(false);
  // once the screen shows it stays: a later recheck changes a verdict, never back to placeholders
  if (known && (ready || waited) && !shown) setShown(true);
  const placeholders = !left && (boot || (known && !shown && !ready && !waited));
  if (!placeholders && !left) setLeft(true);
  useEffect(() => {
    if (!known || ready) return;
    const t = setTimeout(() => setWaited(true), WHOLE_WAIT_MS);
    return () => clearTimeout(t);
  }, [known, ready]);
  if (placeholders) return <FirstRunLoading />;
  // the same render that sets `shown` already shows the screen
  if (known) return !shown && !ready && !waited ? <Connecting /> : models.some(canChat) ? <Found /> : <NoModels />;
  if (rt === "missing" || rt === "stopped" || rt === "wrong" || rt === "error") return <NoOllama />;
  return <Waiting installing={rt === "installing"} />;
}
