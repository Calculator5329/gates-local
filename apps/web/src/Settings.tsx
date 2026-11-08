// Settings (shell.md F20, F27, F36, F45, F46, F59, F62-F66): six sections
// wired to settings.get/update and the v2 methods. A section whose method the
// server answers "not-implemented" says so in one calm line; nothing crashes.
import { useEffect, useState } from "react";
import type { ContextSize, Source } from "@gates-local/contracts";
import { portOf, rtInfo, rtOf } from "./Banner.tsx";
import { CtxLine } from "./FitPanel.tsx";
import { CONTEXT_SIZES, type Verdict, count, describeModel, folderWords, gb, k, sourceDetail, verdictOf } from "./format.ts";
import { Icon } from "./icons.tsx";
import { ModelsPage } from "./Models.tsx";
import { SECTIONS } from "./Sidebar.tsx";
import { addSource, ensureFit, refreshSource, removeSource, setContext, updateSettings } from "./session.ts";
import { NA, type State, fitKey, setState, useStore } from "./store.ts";
import { VLabel } from "./ui.tsx";
import { Fail, Grp, Head, NOT_HERE, Na, Row, useAct } from "./settings-ui.tsx";
import { Updates } from "./Updates.tsx";

function Seg2<T extends string | number>({ value, options, onPick, label }: { value: T | undefined; options: readonly (readonly [T, string])[]; onPick: (v: T) => void; label: string }) {
  return (
    <span className="seg2" role="group" aria-label={label}>
      {options.map(([v, text]) => (
        <button key={String(v)} type="button" className={v === value ? "on" : ""} aria-pressed={v === value} onClick={() => onPick(v)}>
          {text}
        </button>
      ))}
    </span>
  );
}

const catalogOf = (s: State) => (s.catalog === NA ? undefined : s.catalog);

// ---------------------------------------------------------------- General

const SHORTCUTS: readonly (readonly [string, readonly string[]])[] = [
  ["New thread", ["Ctrl", "N"]],
  ["Search threads", ["Ctrl", "K"]],
  ["Choose a model", ["Ctrl", "M"]],
  ["Settings", ["Ctrl", ","]],
  ["Send", ["Enter"]],
  ["New line", ["Shift", "Enter"]],
  ["Approve a pending note", ["Ctrl", "Enter"]],
  ["Close a menu or Settings", ["Esc"]],
];

function General() {
  const settings = useStore((s) => s.settings);
  const unavailable = useStore((s) => s.unavailable["settings.update"] === true);
  const theme = settings === NA ? undefined : settings?.theme;
  const [err, run] = useAct();
  return (
    <>
      <Head title="General">The defaults work out of the box. Nothing here is needed to start chatting.</Head>
      <Grp title="Appearance">
        <Row label="Theme" desc="Dark by default. System follows your desktop." err={err}>
          {settings === NA || unavailable ? (
            <Na>Follows your desktop. Changing it is not available in this build.</Na>
          ) : (
            <Seg2
              label="Theme"
              value={theme}
              options={[
                ["system", "System"],
                ["dark", "Dark"],
                ["light", "Light"],
              ]}
              onPick={(t) => void run(updateSettings({ theme: t }))}
            />
          )}
        </Row>
      </Grp>
      <Grp title="Keyboard shortcuts">
        <table className="kl">
          <tbody>
            {SHORTCUTS.map(([what, keys]) => (
              <tr key={what}>
                <td>{what}</td>
                <td className="k">
                  {keys.map((x) => (
                    <kbd key={x}>{x}</kbd>
                  ))}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </Grp>
      <Updates />
    </>
  );
}

// ---------------------------------------------------------------- Models

function useFit(model: string, numCtx: number): Verdict | undefined {
  const r = useStore((s) => s.fits[fitKey(model, numCtx)]);
  useEffect(() => ensureFit(model, numCtx), [model, numCtx, r]);
  return r === undefined || r === "error" ? undefined : verdictOf(r);
}

/** The default context window, kept in this section where it was; the Models page itself (Models.tsx) holds no context control. */
function DefaultContext() {
  const settingsNA = useStore((s) => s.settings === NA);
  const catalog = useStore(catalogOf);
  const numCtx = useStore((s) => s.numCtx);
  const model = useStore((s) => s.model);
  const v = useFit(model ?? "", numCtx);
  const [ctxErr, runCtx] = useAct();
  return (
    <>
      {model !== undefined ? (
        <Grp title="Default context window">
          <div className="srow">
            <div className="sl">
              <b>Context window</b>
              <span className="d">
                <CtxLine model={model} numCtx={numCtx} />
              </span>
              {v ? (
                <span className="d">
                  {describeModel(model, catalog).name} at {k(numCtx)}: <VLabel v={v} /> · est. {gb(v.need)} of {gb(v.avail)} available to this model
                </span>
              ) : null}
              <Fail err={ctxErr} />
            </div>
            <div className="sv">
              <Seg2<ContextSize>
                label="Context window"
                value={numCtx}
                options={CONTEXT_SIZES.map((c) => [c, k(c)] as const)}
                onPick={(c) => {
                  setContext(c);
                  if (!settingsNA) void runCtx(updateSettings({ defaultNumCtx: c }));
                }}
              />
            </div>
          </div>
        </Grp>
      ) : null}
    </>
  );
}

// ---------------------------------------------------------------- Runtime

function Runtime() {
  const conn = useStore((s) => s.conn);
  const runtime = useStore((s) => s.runtime);
  const confirm = useStore((s) => s.ownerConfirm);
  const settings = useStore((s) => s.settings);
  const models = useStore((s) => s.models);
  const rt = rtOf({ conn, runtime });
  const info = rtInfo({ conn, runtime, settings });
  const port = portOf(runtime?.baseUrl);
  const app = runtime?.owner === "app";
  const stat =
    rt === "ready" ? "Running" : rt === "installing" ? "Installing" : rt === "starting" ? "Starting" : rt === "missing" ? "Not installed" : rt === "wrong" ? `Port ${port} busy` : rt === "offline" ? "Reconnecting" : rt === "stopped" ? "Stopped" : "Didn't start";
  const statD =
    rt === "ready"
      ? app
        ? `Gates Local's copy · port ${port}. It starts and stops with the app.`
        : `Started by your system · port ${port}. Gates Local won't stop it.`
      : rt === "installing"
        ? "Installing Gates Local's copy."
        : rt === "starting"
          ? `Waiting for the server on port ${port}.`
          : rt === "missing"
            ? "No Ollama is installed. Gates Local can install its own copy."
            : rt === "wrong"
              ? `Something other than Ollama answers on port ${port}.`
              : (runtime?.detail ?? info.tip);
  const canSwitch = settings !== NA && settings !== undefined;
  const [err, run] = useAct();
  const total = (models ?? []).reduce((a, m) => a + m.sizeBytes, 0);
  const folders = folderWords();
  return (
    <>
      <Head title="Runtime">Gates Local finds Ollama on its own.</Head>
      <Grp title="Ollama">
        <Row
          label={
            <span className="stat">
              <span className={`dot ${info.dot}`} />
              {stat}
            </span>
          }
          desc={statD}
        />
        {rt === "ready" ? (
          <>
            <Row label={app ? "Switch to the system Ollama" : "Switch to Gates Local's copy"} desc={app ? "The one your system starts" : "A private copy it starts and stops"} err={err}>
              {canSwitch ? (
                <button type="button" className={`btn outline${confirm ? " pressed" : ""}`} aria-expanded={confirm} onClick={() => setState({ ownerConfirm: !confirm })}>
                  Switch…
                </button>
              ) : (
                <Na />
              )}
            </Row>
            {confirm && canSwitch ? (
              <div className="cfm" role="group" aria-label="Confirm switch">
                {app ? (
                  <>
                    <b>Switch back to the system Ollama?</b>
                    <ul>
                      <li>Gates Local stops its copy and connects to the system one on port 11434.</li>
                      <li>
                        The system one reads its own models folder, <span className="mono">{folders.models}</span>. Models downloaded into Gates Local's copy stay in <span className="mono">{folders.appModels}</span>.
                      </li>
                      <li>
                        Its copy stays in <span className="mono">{folders.appCopy}</span> until you remove it.
                      </li>
                      <li>Chats pause for a few seconds while it reconnects.</li>
                    </ul>
                  </>
                ) : (
                  <>
                    <b>Switch to Gates Local's own copy of Ollama?</b>
                    <ul>
                      <li>
                        Downloads Ollama into <span className="mono">{folders.appCopy}</span>.
                      </li>
                      <li>
                        It keeps its own models in <span className="mono">{folders.appModels}</span>, apart from the system one, so a model you want there downloads again. The models in{" "}
                        <span className="mono">{folders.models}</span> stay where they are.
                      </li>
                      <li>It runs on port 11435. The system Ollama keeps running for other apps.</li>
                      <li>Chats pause for about a minute while it installs and starts.</li>
                    </ul>
                  </>
                )}
                <div className="ca">
                  <button type="button" className="btn ghost" onClick={() => setState({ ownerConfirm: false })}>
                    Cancel
                  </button>
                  <button
                    type="button"
                    className="btn primary"
                    onClick={() => {
                      setState({ ownerConfirm: false });
                      void run(updateSettings({ runtimeMode: app ? "system" : "app" }));
                    }}
                  >
                    {app ? "Switch" : "Install and switch"}
                  </button>
                </div>
              </div>
            ) : null}
          </>
        ) : null}
        <Row label="Port" desc="Where Gates Local looks for Ollama.">
          <span className="path">{port}</span>
        </Row>
      </Grp>
      <Grp title="Storage">
        <Row label="Models folder" desc={models ? `${count(models.length, "model")} · ${gb(total)} on disk` : undefined}>
          <span className="path">{app ? folders.appModels : folders.models}</span>
        </Row>
      </Grp>
    </>
  );
}

// ---------------------------------------------------------------- Memory, Images, Library

function Memory() {
  return (
    <>
      <Head title="Memory">Say "remember" in a chat and the model proposes a note. You see the diff before anything is saved.</Head>
      <Grp title="Notes">
        <Row label="Notes folder" desc="Plain Markdown files you can open and edit yourself.">
          <Na />
        </Row>
        <Row label="Approval" desc="Every note edit waits as a diff above the message box.">
          <span className="lockv tipd" tabIndex={0} data-tip="This can't be turned off. The model never writes a note on its own.">
            <Icon id="lock" cls="s14" />
            Always required
          </span>
        </Row>
      </Grp>
    </>
  );
}

const IMAGE_WORDS: Record<string, string> = {
  off: "Off.",
  missing: "No ComfyUI install was found.",
  stopped: "Found. Started only when a chat asks for an image.",
  starting: "Starting ComfyUI.",
  ready: "Running.",
  busy: "Making an image.",
  error: "ComfyUI reported a problem.",
};

function Images() {
  const settings = useStore((s) => s.settings);
  const status = useStore((s) => s.imageStatus);
  const [url, setUrl] = useState<string | null>(null);
  const [genErr, runGen] = useAct();
  const [urlErr, runUrl] = useAct();
  const on = settings !== NA && settings?.imageGen === true;
  const comfy = settings === NA ? undefined : settings?.comfyUrl;
  return (
    <>
      <Head title="Image generation">Off by default. When on, the model can queue image jobs in ComfyUI on this GPU.</Head>
      <Grp title="ComfyUI">
        <Row label="Generate images" desc={settings === NA ? NOT_HERE : on ? "On. The Image toggle in the message box turns it on for a chat." : "Off. The model can't queue image jobs."} err={genErr}>
          {settings === NA ? null : (
            <button
              type="button"
              className="switch"
              role="switch"
              aria-checked={on}
              aria-label="Generate images"
              onClick={() => void runGen(updateSettings({ imageGen: !on }))}
            />
          )}
        </Row>
        <Row label="ComfyUI install" desc={status === NA ? NOT_HERE : status === undefined ? "Checking…" : `${IMAGE_WORDS[status.state] ?? ""}${status.detail ? ` ${status.detail}` : ""}`}>
          {status !== NA && status?.baseUrl ? <span className="path">{status.baseUrl}</span> : null}
        </Row>
        {settings !== NA && settings !== undefined ? (
          <Row label="ComfyUI address" desc="Where Gates Local finds ComfyUI." err={urlErr}>
            <input
              className="inp"
              aria-label="ComfyUI address"
              placeholder="http://127.0.0.1:8188"
              value={url ?? comfy ?? ""}
              onChange={(e) => setUrl(e.target.value)}
              onBlur={() => {
                if (url === null) return;
                // the typed address stays until the server saved it (W-07)
                void runUrl(updateSettings({ comfyUrl: url.trim() === "" ? null : url.trim() })).then((ok) => ok && setUrl(null));
              }}
            />
          </Row>
        ) : null}
      </Grp>
    </>
  );
}

function SourceRow({ src }: { src: Source }) {
  const [err, run] = useAct();
  return (
    <Row label={src.label || src.path} desc={`${src.kind === "sqlite" ? "SQLite · " : ""}${sourceDetail(src)}`} err={err}>
      <span className="badge">read-only</span>
      <button type="button" className="qa" onClick={() => void run(refreshSource(src.id))}>
        Refresh
      </button>
      <button type="button" className="qa" onClick={() => void run(removeSource(src.id))}>
        Remove
      </button>
    </Row>
  );
}

/** "Add folder…" opens a path field: the browser cannot pick a folder path (desktop picker wanted). */
function AddSource({ kind, label, desc, button, icon }: { kind: "folder" | "file" | "sqlite"; label: string; desc: string; button: string; icon: "folder" | "file" | "db" }) {
  const [open, setOpen] = useState(false);
  const [path, setPath] = useState("");
  const [err, run] = useAct();
  return (
    <Row label={label} desc={desc} err={err}>
      {open ? (
        <>
          <input
            className="inp"
            aria-label={`${label} path`}
            placeholder={kind === "folder" ? "~/docs" : kind === "sqlite" ? "~/docs/library.db" : "~/notes/todo.md"}
            value={path}
            onChange={(e) => setPath(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape") {
                e.stopPropagation();
                setOpen(false);
              }
            }}
          />
          <button
            type="button"
            className="btn outline"
            disabled={path.trim() === ""}
            onClick={() => {
              // the form keeps the typed path until the server added it (W-07)
              void run(addSource(kind, path)).then((ok) => {
                if (!ok) return;
                setPath("");
                setOpen(false);
              });
            }}
          >
            Add
          </button>
        </>
      ) : (
        <button type="button" className="btn outline" onClick={() => setOpen(true)}>
          <Icon id={icon} cls="s14" />
          {button}
        </button>
      )}
    </Row>
  );
}

function Library() {
  const sources = useStore((s) => s.sources);
  const list = sources === NA || sources === undefined ? [] : sources;
  const head = (
    <Head title="Library">Sources the model may read in every chat: folders, files and databases. Everything here is read-only; nothing is connected on its own.</Head>
  );
  if (sources === NA) {
    return (
      <>
        {head}
        <p className="na">The Library is not available in this build.</p>
      </>
    );
  }
  return (
    <>
      {head}
      <Grp title="Folders">
        {list
          .filter((x) => x.kind !== "sqlite")
          .map((x) => (
            <SourceRow key={x.id} src={x} />
          ))}
        <AddSource kind="folder" label="Add a folder" desc="Pick a folder of notes, books or documents." button="Add folder…" icon="folder" />
        <AddSource kind="file" label="Add a file" desc="One document the model may read." button="Add file…" icon="file" />
      </Grp>
      <Grp title="Databases">
        {list
          .filter((x) => x.kind === "sqlite")
          .map((x) => (
            <SourceRow key={x.id} src={x} />
          ))}
        <AddSource kind="sqlite" label="Add a database" desc="SQLite files are opened read-only." button="Add database…" icon="db" />
      </Grp>
    </>
  );
}

export function SettingsView() {
  const section = useStore((s) => s.section);
  const addPage = useStore((s) => s.addPage);
  void SECTIONS;
  switch (section) {
    case "general":
      return <General />;
    case "models":
      return (
        <>
          <ModelsPage />
          {addPage ? null : <DefaultContext />}
        </>
      );
    case "runtime":
      return <Runtime />;
    case "memory":
      return <Memory />;
    case "images":
      return <Images />;
    case "library":
      return <Library />;
  }
}
