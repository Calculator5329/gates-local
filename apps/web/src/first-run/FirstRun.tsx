// First run (shell.md F32, F43, F44b, F54, F62): one screen before the first
// chat. Found: a recommended installed model and Start chatting. No Ollama: a
// calm status with Retry. No models: download the recommended one, with
// progress and Cancel; the chat can open to draft while it downloads.
import { type ReactNode, useEffect, useState } from "react";
import type { CatalogEntry } from "@gates-local/contracts";
import { suggestedOf } from "../picker/picker-models.ts";
import { recommendedEntry } from "../runtime/Banner.tsx";
import { CONNECTING, INSTALL_TITLE, STALLED, booting, failWords, installStep, installWords, ownCopyNote, portOf, rtOf, underTitle, unread, useInstallStall } from "../runtime/words.tsx";
import { DlButton, canCancelPull } from "../models/ModelDownloads.tsx";
import { type Verdict, cardGb, ctxFor, describeModel, etaText, gb, k, noGpu, verdictOf } from "../lib/words/format.ts";
import { Icon } from "../lib/ui/icons.tsx";
import { type RowPhase, phaseOf, rowOf } from "../fit/fit-table.ts";
import { finishFirstRun, firstPull, openSettings, pull, cancelPull, recheckRuntime } from "../lib/session/index.ts";
import { NA, type State, useStore } from "../lib/store/store.ts";
import { canChat, chatBlockedReason, chatModels, pickedModel } from "../models/pick.ts";
import { focusComposer } from "../composer/focus.ts";
import { VLabel } from "../lib/ui/ui.tsx";
import { FirstRunLoading, Shell } from "./FirstRunShell.tsx";

function Cta({ label, onGo, link, onLink }: { label: string; onGo: () => void; link?: string; onLink?: () => void }) {
  return (
    <div className="fr-cta">
      <button type="button" className="btn primary lg" data-testid="first-run.cta.go" onClick={onGo}>
        {label}
        <Icon id="arrow" cls="s14" />
      </button>
      {link ? (
        <button type="button" className="link" data-testid="first-run.cta.link" onClick={onLink}>
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

/**
 * The recommended model card: name and verdict, a download's size when it is
 * one, and a Details disclosure. The model's purpose phrase is not here: the
 * screen is about whether it runs, and the picker and Settings carry it.
 */
function RecCard({ tag, have, entry, children }: { tag: string; have: boolean; entry?: CatalogEntry | undefined; children?: ReactNode }) {
  const [open, setOpen] = useState(false);
  const catalog = useStore((s) => (s.catalog === NA ? undefined : s.catalog));
  const info = useStore((s) => s.models?.find((m) => m.name === tag));
  const cpu = useStore((s) => noGpu(s.gpu));
  const ctx = useStore((s) => ctxFor(s.numCtx, s.models, tag));
  const fit = useStore((s) => rowOf(s, tag));
  const phase = useStore((s) => phaseOf(s.fitTable, rowOf(s, tag)));
  const v = fit ? verdictOf(fit) : undefined;
  const d = describeModel(tag, catalog);
  return (
    <div className="fr-card">
      <div className="fr-m">
        <span className="nm">{d.name}</span>
        <span className="rec">
          <span className="sep">· </span>
          Recommended
        </span>
        <span className="v" data-wait="" data-watch="fit">
          {v ? <VLabel v={v} /> : pendingWord(phase)}
        </span>
      </div>
      {!have && entry ? <div className="fr-sub">{gb(entry.downloadBytes)} download</div> : null}
      <button type="button" className="think" data-testid="first-run.model.details" aria-expanded={open} onClick={() => setOpen(!open)}>
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
              <td>Context</td>
              <td>{k(ctx)}</td>
            </tr>
            {fit ? (
              <tr>
                <td>{cpu ? "Memory" : "GPU memory"}</td>
                <td>{cpu ? `Estimated ${gb(fit.needVramBytes)}, all in system memory (no supported GPU)` : `Estimated ${gb(fit.needVramBytes)} of a ${cardGb(fit.freeVramBytes)} GPU`}</td>
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

function NoModels() {
  const [cancelled, setCancelled] = useState(false);
  const entry = useStore(recommendedEntry);
  const catalogNA = useStore((s) => s.catalog === NA);
  const pullNA = useStore((s) => s.unavailable["models.pull"] === true);
  const example = useStore((s) => suggestedOf(s)?.example);
  const canCancel = useStore(canCancelPull);
  const active = useStore(firstPull);
  const p = useStore((s) => (active === undefined ? undefined : s.pulls[active]));
  const cpu = useStore((s) => noGpu(s.gpu));
  const fresh = useStore(s => entry === undefined ? undefined : rowOf(s, entry.name));
  // Ollama is fine here, so the status line says nothing (it speaks only when Ollama is missing,
  // stopped, failed or installing). The space keeps the line's height, so the title sits where it
  // does on every other first-run screen.
  const st = "\u00A0";
  // An Ollama that does not report capabilities: a download would not help, so say what would.
  const tooOld = useStore((s) => chatBlockedReason(s.models, undefined));
  // a sentence only for what the title and the card's verdict do not say, in the server's words: the
  // number a refusal turns on, or system memory where the card's word would name a GPU
  const sub = tooOld ?? (fresh === undefined ? undefined : foundWords(verdictOf(fresh), cpu).sub);
  if (active !== undefined && p !== undefined) {
    return (
      <Shell st={st} title="Downloading your first model" sub={sub}>
        <RecCard tag={active} have={false} entry={entry?.name === active ? entry : undefined}>
          {/* the Download tab's own button: the percent fills it, the × beside it cancels */}
          <div className="fr-dl">
            <span className="fr-dl-l">{etaText(p, { speed: false })}</span>
            <DlButton
              size={p.totalBytes === undefined ? undefined : gb(p.totalBytes)}
              label={describeModel(active, undefined).name}
              p={p}
              onCancel={canCancel ? () => {
                setCancelled(true);
                void cancelPull(active);
              } : undefined}
            />
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
      <Shell st={st} title={pullNA ? "No model installed yet" : "Download your first model"}>
        <p className="fr-note na">
          {pullNA || catalogNA ? "Gates Local can't download models from here. " : ""}
          On the computer, download one with Ollama{example === undefined ? "" : <>, for example <span className="mono">ollama pull {example}</span></>}, then press Retry.
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
            <button type="button" className="link" data-testid="first-run.cancelled.open-models" onClick={() => openSettings("models", true)}>
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

/** The server's words as one sentence: "needs 2.0 GB more" reads "Needs 2.0 GB more."; nothing when it sent none. */
const sentence = (words: string): { sub?: string } => (words === "" ? {} : { sub: `${words.charAt(0).toUpperCase()}${words.slice(1)}.` });

/**
 * The model's verdict in the server's words (FitReport.words, printed as sent, as the model row
 * prints them; the client makes no fit sentence of its own). A refusal says nothing about the other
 * installed models. The title and the card's verdict say whether it runs; a sentence is added only
 * for the number a refusal turns on, or, on a computer with no supported GPU where the card's word
 * would name one, the server's label.
 */
export function foundWords(v: Pick<Verdict, "k" | "label" | "detail"> | undefined, cpu = false): { title: string; sub?: string } {
  if (v?.k === "no") return { title: "Choose another model", ...sentence(v.detail) };
  if (cpu && v?.k === "gpu") return { title: "Ready to chat", ...sentence(v.label) };
  return { title: "Ready to chat" };
}

function Found() {
  const count = useStore((s) => chatModels(s.models ?? []).length);
  const picked = useStore((s) => pickedModel(s.models));
  // The composer starts on the same model (session.ts reads the same pick).
  const tag = useStore((s) => s.model ?? picked?.name);
  const cpu = useStore((s) => noGpu(s.gpu));
  const fresh = useStore(s => rowOf(s, tag));
  const phase = useStore(s => phaseOf(s.fitTable, rowOf(s, tag)));
  // no row for it: the title says what the card's slot says (still checking, or the table has no
  // reading for it); no sentence, never "Ready"
  const words = fresh !== undefined ? foundWords(verdictOf(fresh), cpu) : { title: phase === "checking" ? "Checking memory" : "Couldn't check memory" };
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
  const failure = useStore((s) => s.runtime?.failure);
  const note = useStore(ownCopyNote);
  const computerOnly = useStore((s) => s.unavailable["runtime.retry"] === true);
  const own = note !== "";
  const around = own ? `${note} ` : "";
  const port = portOf(baseUrl);
  // the heading says what is wrong and the sentence the cause or the step; the status line is the
  // dot and "Ollama", except a busy port's, which is its cause (so it has no sentence)
  const [title, st, sub]: [string, string, string | undefined] =
    rt === "wrong"
      ? ["Ollama isn't answering", `Something else holds port ${port}`, undefined]
      : rt === "stopped"
        ? ["Ollama is stopped", "Ollama", own ? `${around}It starts when Gates Local opens; press Retry to check again.` : "Start Ollama, then press Retry."]
        : rt === "error"
          ? [failWords(failure).title, "Ollama", underTitle(detail, failure)]
          : ["Ollama isn't installed", "Ollama", `${around}${computerOnly ? "On the computer, install" : "Install"} Ollama from ollama.com, then press Retry.`];
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
      {rt === "error" && computerOnly ? <p className="fr-note na">Gates Local can't fix this from here. On the computer, press Retry in Gates Local.</p> : null}
      <Cta label="Retry" onGo={() => void recheckRuntime()} link="Settings" onLink={() => finishFirstRun("runtime")} />
    </Shell>
  );
}

/** Nothing to say yet but that the app is connecting; the dot holds the status line. */
function Connecting() {
  return <Shell st={<span className="dot run" />} title={CONNECTING} />;
}

// the step words live with the banner, which says them too (runtime/words.tsx)
export { installStep, installWords };

function Waiting({ installing }: { installing: boolean }) {
  // the runtime has not answered once: no Ollama words yet
  const none = useStore(unread);
  const install = useStore((s) => s.runtime?.install);
  const { stalled, words, retry } = useInstallStall(installing ? install : undefined);
  // the app's own copy starting (after its download) is not a search
  const own = useStore((s) => s.runtime?.state === "starting" && s.runtime.owner === "app");
  if (none) return <Connecting />;
  return (
    <Shell
      st={
        <>
          <span className={stalled ? "dot warn" : "dot run"} />
          {stalled ? STALLED : installing ? installStep(install) : own ? "Starting Ollama" : "Looking for Ollama"}
        </>
      }
      title={installing ? INSTALL_TITLE : "Starting up"}
      sub={installing && words !== undefined ? <span className="fig">{words}</span> : undefined}
    >
      {installing ? (
        <>
          {/* a stalled download's one act is Retry; chatting early stays beside it */}
          {stalled ? (
            <Cta label="Retry" onGo={retry} link="Start chatting" onLink={startChat} />
          ) : (
            <Cta label="Start chatting" onGo={startChat} link="Settings" onLink={() => finishFirstRun("general")} />
          )}
          <p className="fr-note">You can type now; replies start once the engine and a first model are in.</p>
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
