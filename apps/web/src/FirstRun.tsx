// First run (shell.md F32, F43, F44b, F54, F62): one screen before the first
// chat. Found: a recommended installed model and Start chatting. No Ollama: a
// calm status with Retry. No models: download the recommended one, with
// progress and Cancel; the chat can open to draft while it downloads.
import { type ReactNode, useState } from "react";
import type { CatalogEntry } from "@gates-local/contracts";
import { portOf, rtOf } from "./Banner.tsx";
import { DlDetail } from "./Settings.tsx";
import { describeModel, gb, k, verdictOf } from "./format.ts";
import { Icon } from "./icons.tsx";
import { ensureFit, finishFirstRun, firstPull, openSettings, pull, cancelPull, recheckRuntime } from "./session.ts";
import { NA, type State, fitKey, useStore } from "./store.ts";
import { VLabel } from "./ui.tsx";

function Shell({ st, title, sub, children }: { st: ReactNode; title: string; sub: ReactNode; children?: ReactNode }) {
  return (
    <div className="fr">
      <div className="fr-brand">
        <svg className="mark" aria-hidden="true">
          <use href="#i-mark" />
        </svg>
        Gates Local
      </div>
      <div className="fr-st">{st}</div>
      <h1>{title}</h1>
      <p className="sub">{sub}</p>
      {children}
      <div className="fr-foot">
        <Icon id="lock" cls="s14" />
        Runs locally on your computer. Nothing you type leaves it.
      </div>
    </div>
  );
}

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

const CTX_TIP = "How much of the conversation the model keeps in view. Bigger needs more GPU memory.";

/** The recommended model card: name, verdict, purpose, and a Details disclosure. */
function RecCard({ tag, have, entry, children }: { tag: string; have: boolean; entry?: CatalogEntry | undefined; children?: ReactNode }) {
  const [open, setOpen] = useState(false);
  const numCtx = useStore((s) => s.numCtx);
  const catalog = useStore((s) => (s.catalog === NA ? undefined : s.catalog));
  const info = useStore((s) => s.models?.find((m) => m.name === tag));
  const report = useStore((s) => s.fits[fitKey(tag, numCtx)]);
  if (have) ensureFit(tag, numCtx);
  const fit = entry?.fit ?? (report === undefined || report === "error" ? undefined : report);
  const v = fit ? verdictOf(fit) : undefined;
  const d = describeModel(tag, catalog);
  return (
    <div className="fr-card">
      <div className="fr-m">
        <span className="nm">{d.name}</span>
        <span className="rec">
          ·{" "}
          <span className="tipd" tabIndex={0} data-tip={have ? `The fastest installed model that runs on your GPU with room for ${k(numCtx)} of context.` : `The best model for your GPU with room for ${k(numCtx)} of context.`}>
            Recommended
          </span>
        </span>
        {v ? (
          <span className="v">
            <VLabel v={v} />
          </span>
        ) : null}
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
              <td>{k(numCtx)}</td>
            </tr>
            {v ? (
              <tr>
                <td>GPU memory</td>
                <td>
                  Estimated {gb(v.need)} of {gb(v.avail)} available
                </td>
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
  const version = useStore((s) => s.runtime?.version);
  const entry = useStore(recommendedEntry);
  const catalogNA = useStore((s) => s.catalog === NA);
  const pullNA = useStore((s) => s.unavailable["models.pull"] === true);
  const active = useStore(firstPull);
  const p = useStore((s) => (active === undefined ? undefined : s.pulls[active]));
  const numCtx = useStore((s) => s.numCtx);
  const st = (
    <>
      <span className="dot ok" />
      Ollama{version ? ` ${version}` : ""} · no models yet
    </>
  );
  const sub = `One model is enough. This one runs on your GPU with room for ${k(numCtx)} of context.`;
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
        <Cta label="Start chatting" onGo={() => finishFirstRun("chat")} />
        <p className="fr-note">You can type now; replies start when the download finishes.</p>
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

function Found() {
  const version = useStore((s) => s.runtime?.version);
  const count = useStore((s) => s.models?.length ?? 0);
  const tag = useStore((s) => s.model ?? s.models?.[0]?.name);
  return (
    <Shell
      st={
        <>
          <span className="dot ok" />
          Ollama{version ? ` ${version}` : ""} · {count} local {count === 1 ? "model" : "models"}
        </>
      }
      title="Ready to chat"
      sub="Gates Local picked the best model for your GPU. Switch models in any chat."
    >
      {tag !== undefined ? <RecCard tag={tag} have /> : null}
      <Cta label="Start chatting" onGo={() => finishFirstRun("chat")} link="Change defaults in Settings" onLink={() => finishFirstRun("general")} />
    </Shell>
  );
}

function NoOllama() {
  const rt = useStore(rtOfState);
  const baseUrl = useStore((s) => s.runtime?.baseUrl);
  const detail = useStore((s) => s.runtime?.detail);
  const port = portOf(baseUrl);
  const [title, st, sub] =
    rt === "wrong"
      ? ["Ollama isn't answering", `Port ${port} is busy`, `Something other than Ollama answers on port ${port}.`]
      : rt === "stopped"
        ? ["Ollama is stopped", "Ollama is installed but not running", "Start Ollama, then press Retry."]
        : rt === "error"
          ? ["Ollama didn't start", "Ollama reported a problem", (detail ?? "Ollama stopped with an error.")]
          : ["Ollama isn't installed", "No Ollama found on this computer", "Gates Local needs Ollama to chat. Install it from ollama.com, then press Retry."];
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
          <Cta label="Start chatting" onGo={() => finishFirstRun("chat")} link="Settings" onLink={() => finishFirstRun("general")} />
          <p className="fr-note">You can type now; replies start when setup finishes.</p>
        </>
      ) : null}
    </Shell>
  );
}

export function FirstRun() {
  const rt = useStore(rtOfState);
  const models = useStore((s) => s.models);
  if (rt === "ready" && models !== undefined) return models.length > 0 ? <Found /> : <NoModels />;
  if (rt === "missing" || rt === "stopped" || rt === "wrong" || rt === "error") return <NoOllama />;
  return <Waiting installing={rt === "installing"} />;
}

/** In a browser with no ?server= and no build-time server URL, nothing can connect. */
export function NoServer() {
  return (
    <Shell
      st={
        <>
          <span className="dot err" />
          No server address
        </>
      }
      title="Gates Local can't find its server"
      sub={
        <>
          Start it from the desktop app, or open this page with <span className="mono">?server=</span> set to the server's encoded address,{" "}
          <span className="mono">ws://127.0.0.1:PORT/?token=…</span>
        </>
      }
    />
  );
}
