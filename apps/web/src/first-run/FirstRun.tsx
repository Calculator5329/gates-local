import { type ReactNode, useState } from "react";
import type { CatalogEntry } from "@gates-local/contracts";
import { suggestedOf } from "../picker/picker-models.ts";
import { recommendedEntry } from "../runtime/first-offer.ts";
import { CONNECTING, INSTALL_TITLE, STALLED, booting, failWhy, failWords, installStep, installWords, ownCopyNote, portOf, rtOf, underTitle, unread, useInstallStall } from "../runtime/words.tsx";
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
import { useAfter } from "../lib/ui/kit/flash.ts";

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

function startChat(): void {
  finishFirstRun("chat");
  focusComposer();
}

// why: the first message queues while the model downloads, and the model button shows its progress
function downloadAndChat(name: string): void {
  void pull(name);
  startChat();
}

const pendingWord = (phase: RowPhase): string => (phase === "checking" ? "Checking…" : "Couldn't check");

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
  const st = "\u00A0";
  const tooOld = useStore((s) => chatBlockedReason(s.models, undefined));
  const sub = tooOld ?? (fresh === undefined ? undefined : foundWords(verdictOf(fresh), cpu).sub);
  if (active !== undefined && p !== undefined) {
    return (
      <Shell st={st} title="Downloading your first model" sub={sub}>
        <RecCard tag={active} have={false} entry={entry?.name === active ? entry : undefined}>
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
    return (
      <Shell st={st} title="Update Ollama to chat" sub={tooOld}>
        <Cta label="Retry" onGo={() => void recheckRuntime()} />
      </Shell>
    );
  }
  if (entry === undefined || pullNA) {
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
              downloadAndChat(entry.name);
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
        <Cta label="Download and start" onGo={() => downloadAndChat(entry.name)} link="Choose another model" onLink={() => openSettings("models", true)} />
      )}
    </Shell>
  );
}

const sentence = (words: string): { sub?: string } => (words === "" ? {} : { sub: `${words.charAt(0).toUpperCase()}${words.slice(1)}.` });

export function foundWords(v: Pick<Verdict, "k" | "label" | "detail"> | undefined, cpu = false): { title: string; sub?: string } {
  if (v?.k === "no") return { title: "Choose another model", ...sentence(v.detail) };
  if (cpu && v?.k === "gpu") return { title: "Ready to chat", ...sentence(v.label) };
  return { title: "Ready to chat" };
}

function Found() {
  const count = useStore((s) => chatModels(s.models ?? []).length);
  const picked = useStore((s) => pickedModel(s.models));
  const tag = useStore((s) => s.model ?? picked?.name);
  const cpu = useStore((s) => noGpu(s.gpu));
  const fresh = useStore(s => rowOf(s, tag));
  const phase = useStore(s => phaseOf(s.fitTable, rowOf(s, tag)));
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
      why={rt === "error" ? failWhy(detail, failure) : undefined}
    >
      {rt === "error" && computerOnly ? <p className="fr-note na">Gates Local can't fix this from here. On the computer, press Retry in Gates Local.</p> : null}
      <Cta label="Retry" onGo={() => void recheckRuntime()} link="Settings" onLink={() => finishFirstRun("runtime")} />
    </Shell>
  );
}

function Connecting() {
  return <Shell st={<span className="dot run" />} title={CONNECTING} />;
}

export { installStep, installWords };

function Waiting({ installing }: { installing: boolean }) {
  const none = useStore(unread);
  const install = useStore((s) => s.runtime?.install);
  const { stalled, words, retry } = useInstallStall(installing ? install : undefined);
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

const WHOLE_WAIT_MS = 1000;

function screenModel(s: State): string | undefined {
  if (s.models === undefined) return undefined;
  return s.models.some(canChat) ? (s.model ?? pickedModel(s.models)?.name) : recommendedEntry(s)?.name;
}

function inHand(s: State): boolean {
  if (chatBlockedReason(s.models, undefined) !== undefined || s.unavailable["models.pull"] === true) return true;
  if (s.catalog === undefined) return false;
  const tag = screenModel(s);
  if (tag === undefined) return true;
  return phaseOf(s.fitTable, rowOf(s, tag)) !== "checking";
}

export function FirstRun() {
  const rt = useStore(rtOfState);
  const boot = useStore(booting);
  const models = useStore((s) => s.models);
  const ready = useStore(inHand);
  const known = !boot && rt === "ready" && models !== undefined;
  // why: after this long the screen shows without the slow read; shown and left keep what it drew
  const waited = useAfter(WHOLE_WAIT_MS, known && !ready ? "wait" : null);
  const [shown, setShown] = useState(false);
  const [left, setLeft] = useState(false);
  if (known && (ready || waited) && !shown) setShown(true);
  const placeholders = !left && (boot || (known && !shown && !ready && !waited));
  if (!placeholders && !left) setLeft(true);
  if (placeholders) return <FirstRunLoading />;
  if (known) return !shown && !ready && !waited ? <Connecting /> : models.some(canChat) ? <Found /> : <NoModels />;
  if (rt === "missing" || rt === "stopped" || rt === "wrong" || rt === "error") return <NoOllama />;
  return <Waiting installing={rt === "installing"} />;
}
