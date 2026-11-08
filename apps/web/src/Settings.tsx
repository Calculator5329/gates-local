// Settings (shell.md F20, F27, F36, F45, F46, F59, F62-F66): six sections
// wired to settings.get/update and the v2 methods. A section whose method the
// server answers "not-implemented" says so in one calm line; nothing crashes.
import { type ReactNode, useEffect, useState } from "react";
import type { CatalogEntry, ContextSize, PullProgress, Settings, Source } from "@gates-local/contracts";
import { portOf, rtInfo, rtOf } from "./Banner.tsx";
import { CtxLine, openFit, shortGpu } from "./FitPanel.tsx";
import { CONTEXT_SIZES, type Verdict, describeModel, etaText, gb, k, verdictOf } from "./format.ts";
import { Icon } from "./icons.tsx";
import { SECTIONS } from "./Sidebar.tsx";
import { addSource, cancelPull, ensureFit, pull, refreshSource, removeModel, removeSource, setContext, updateSettings } from "./session.ts";
import { NA, type State, fitKey, setState, useStore } from "./store.ts";
import { canChat, notForChat } from "./pick.ts";
import { VLabel, closeTip, esc } from "./ui.tsx";

const NOT_HERE = "Not available in this build.";

function Head({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="set-h">
      <h1>{title}</h1>
      <p>{children}</p>
    </div>
  );
}

function Grp({ title, children }: { title?: string; children: ReactNode }) {
  return (
    <div className="grp">
      {title ? <div className="grp-t">{title}</div> : null}
      <div className="box">{children}</div>
    </div>
  );
}

function Row({ label, desc, children }: { label: ReactNode; desc?: ReactNode; children?: ReactNode }) {
  return (
    <div className="srow">
      <div className="sl">
        <b>{label}</b>
        {desc !== undefined ? <span className="d">{desc}</span> : null}
      </div>
      <div className="sv">{children}</div>
    </div>
  );
}

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

const Na = ({ children = NOT_HERE }: { children?: ReactNode }) => <span className="na">{children}</span>;

const settingsOf = (s: State): Settings | undefined => (s.settings === NA ? undefined : s.settings);
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
  return (
    <>
      <Head title="General">The defaults work out of the box. Nothing here is needed to start chatting.</Head>
      <Grp title="Appearance">
        <Row label="Theme" desc="Dark by default. System follows your desktop.">
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
              onPick={(t) => void updateSettings({ theme: t })}
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
    </>
  );
}

// ---------------------------------------------------------------- Models

/** One download detail everywhere a download runs (F64): bar, bytes, speed, time left, Cancel download. */
export function DlDetail({ p, name, cancel = true }: { p: PullProgress; name: string; cancel?: boolean }) {
  const pct = p.totalBytes ? Math.round((p.completedBytes / p.totalBytes) * 100) : 0;
  return (
    <>
      <div className="prog" role="progressbar" aria-label={`${name} download`} aria-valuenow={pct}>
        <i style={{ width: `${pct}%` }} />
      </div>
      <div className="prog-l">
        <span>{etaText(p)}</span>
        {cancel ? (
          <button
            type="button"
            className="qa"
            onClick={() => {
              closeTip();
              void cancelPull(p.name);
            }}
          >
            Cancel download
          </button>
        ) : null}
      </div>
    </>
  );
}

const activePulls = (s: State) => s.pulls;
const isActive = (p: PullProgress) => p.state === "queued" || p.state === "downloading" || p.state === "verifying";

function useFit(model: string, numCtx: number): Verdict | undefined {
  const r = useStore((s) => s.fits[fitKey(model, numCtx)]);
  useEffect(() => ensureFit(model, numCtx), [model, numCtx, r]);
  return r === undefined || r === "error" ? undefined : verdictOf(r);
}

function ModelRow({ tag, numCtx, on }: { tag: string; numCtx: number; on: boolean }) {
  const catalog = useStore(catalogOf);
  const info = useStore((s) => s.models?.find((m) => m.name === tag));
  const canRemove = useStore((s) => s.unavailable["models.remove"] !== true);
  const v = useFit(tag, numCtx);
  const d = describeModel(tag, catalog);
  const tip = `<b>${esc(d.name)}</b> · <span class="mono">${esc(tag)}</span>${info?.quantization ? ` · ${esc(info.quantization)}` : ""}<br>${info ? `${gb(info.sizeBytes)} on disk` : ""}${v ? ` · est. ${gb(v.need)} at ${k(numCtx)}` : ""}`;
  const inner = (
    <>
      <span className="rd" />
      <span className="mn">
        {d.name}
        <small>{d.purpose}</small>
      </span>
      {v ? <VLabel v={v} cls="mv" /> : <span className="mv na">Checking…</span>}
    </>
  );
  const remove = canRemove ? (
    <button
      type="button"
      className="qa"
      aria-label={`Remove ${d.name}`}
      onClick={(e) => {
        e.stopPropagation();
        void removeModel(tag);
      }}
    >
      Remove
    </button>
  ) : null;
  if (v?.k === "no") {
    return (
      <div className="mrow dis" data-tip={tip}>
        {inner}
        <button type="button" className="qa" data-memdet={tag} onClick={() => openFit(tag)}>
          Memory details
        </button>
        {remove}
      </div>
    );
  }
  return (
    <div style={{ display: "contents" }}>
      <button type="button" className={`mrow${on ? " on" : ""}`} data-dm={tag} data-tip={tip} aria-pressed={on} onClick={() => void updateSettings({ defaultModel: tag })}>
        {inner}
      </button>
      {remove}
    </div>
  );
}

/** An installed embedding model: listed so it can be removed, never a default (it cannot chat). */
function EmbedRow({ tag }: { tag: string }) {
  const catalog = useStore(catalogOf);
  const info = useStore((s) => s.models?.find((m) => m.name === tag));
  const canRemove = useStore((s) => s.unavailable["models.remove"] !== true);
  const d = describeModel(tag, catalog);
  const why = notForChat(info);
  return (
    <div
      className="mrow dis emb"
      data-em={tag}
      data-tip={`<b>${esc(d.name)}</b> · <span class="mono">${esc(tag)}</span><br>${why.tip}${info ? `<br>${gb(info.sizeBytes)} on disk` : ""}`}
    >
      <span className="rd" />
      <span className="mn">{d.name}</span>
      <span className="mv na">{why.label}</span>
      {canRemove ? (
        <button type="button" className="qa" aria-label={`Remove ${d.name}`} onClick={() => void removeModel(tag)}>
          Remove
        </button>
      ) : null}
    </div>
  );
}

function Models() {
  const settings = useStore(settingsOf);
  const settingsNA = useStore((s) => s.settings === NA);
  const models = useStore((s) => s.models);
  const pulls = useStore(activePulls);
  const catalog = useStore(catalogOf);
  const numCtx = useStore((s) => s.numCtx);
  const model = useStore((s) => s.model);
  const v = useFit(model ?? "", numCtx);
  const def = settings?.defaultModel ?? model;
  const downloading = Object.values(pulls).filter((p) => isActive(p) && !(models ?? []).some((m) => m.name === p.name));
  return (
    <>
      <Head title="Models">New chats start on your default model if it runs at {k(numCtx)}, otherwise on your best model that fits the GPU. Change it here; any chat can still switch.</Head>
      <div className="grp">
        <div className="grp-t">Default model</div>
        <div className="box">
          {(models ?? []).map((m) =>
            canChat(m) ? <ModelRow key={m.name} tag={m.name} numCtx={numCtx} on={m.name === def} /> : <EmbedRow key={m.name} tag={m.name} />,
          )}
          {downloading.map((p) => {
            const d = describeModel(p.name, catalog);
            return (
              <div key={p.name} className="mrow dis dlg" aria-disabled="true">
                <span className="rd dl" />
                <div className="mdl">
                  <span className="mn">
                    {d.name}
                    <small>{d.purpose}</small>
                  </span>
                  <DlDetail p={p} name={d.name} />
                </div>
              </div>
            );
          })}
          <button type="button" className="mrow add" onClick={() => setState({ addPage: true })}>
            <Icon id="plus" />
            Download another model…
          </button>
        </div>
      </div>
      {settingsNA ? <p className="na">Saving a default model is not available in this build; each chat uses the one you pick.</p> : null}
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
            </div>
            <div className="sv">
              <Seg2<ContextSize>
                label="Context window"
                value={numCtx}
                options={CONTEXT_SIZES.map((c) => [c, k(c)] as const)}
                onPick={(c) => {
                  setContext(c);
                  if (!settingsNA) void updateSettings({ defaultNumCtx: c });
                }}
              />
            </div>
          </div>
        </Grp>
      ) : null}
    </>
  );
}

function DlRow({ c, numCtx }: { c: CatalogEntry; numCtx: number }) {
  const p = useStore((s) => s.pulls[c.name]);
  const installed = useStore((s) => c.installed || (s.models ?? []).some((m) => m.name === c.name));
  const v = c.fit ? verdictOf(c.fit) : undefined;
  const dling = p !== undefined && isActive(p) && !installed;
  const action = installed ? (
    <span className="badge">Installed</span>
  ) : dling ? (
    <button type="button" className="qa" onClick={() => void cancelPull(c.name)}>
      Cancel download
    </button>
  ) : (
    <button type="button" className="qa" disabled={v?.k === "no"} onClick={() => void pull(c.name)}>
      Download
    </button>
  );
  return (
    <div className={`dlrow${dling ? " dlg" : ""}`}>
      <div className="sl" data-tip={`<b>${esc(c.label)}</b> · <span class="mono">${esc(c.name)}</span>`}>
        <b>{c.label}</b>
        {dling ? (
          <>
            <span className="d">{c.purpose}</span>
            <DlDetail p={p} name={c.label} cancel={false} />
          </>
        ) : (
          <span className="d">
            {c.purpose} · {gb(c.downloadBytes)} download
          </span>
        )}
      </div>
      {v ? (
        <div className="dl-v" data-tip={`Estimated ${gb(v.need)} at ${k(numCtx)}, of ${gb(v.avail)} available on the GPU. Measured after the first load.`}>
          <VLabel v={v} />
          <small>
            est. {gb(v.need)} at {k(numCtx)}
          </small>
        </div>
      ) : (
        <div className="dl-v" />
      )}
      <div className="dl-a">{action}</div>
    </div>
  );
}

function CustomPull() {
  const [name, setName] = useState("");
  return (
    <Row
      label="Any model from the Ollama library"
      desc={
        <>
          Type its name as it appears in the library.
          <span className="d" style={{ display: "block" }}>
            <a className="link" href="https://ollama.com/library" target="_blank" rel="noreferrer noopener" aria-label="Browse the Ollama library at ollama.com/library (opens your browser)">
              Browse the Ollama library ↗
            </a>
          </span>
        </>
      }
    >
      <input className="inp" placeholder="Model name, e.g. phi5:14b" aria-label="Model name" value={name} onChange={(e) => setName(e.target.value)} />
      <button
        type="button"
        className="qa"
        disabled={name.trim() === ""}
        onClick={() => {
          void pull(name);
          setName("");
        }}
      >
        Download
      </button>
    </Row>
  );
}

function DownloadPage() {
  const catalog = useStore((s) => s.catalog);
  const numCtx = useStore((s) => s.numCtx);
  const gpu = useStore((s) => s.gpu);
  const pullNA = useStore((s) => s.unavailable["models.pull"] === true);
  const gpuName = gpu === NA || gpu === undefined || gpu.vendor !== "nvidia" ? "computer" : shortGpu(gpu.name);
  const list = catalog === NA || catalog === undefined ? [] : catalog;
  const rec = list.filter((c) => c.recommended);
  const more = list.filter((c) => !c.recommended);
  const allSpill = more.length > 0 && more.every((c) => c.fit?.verdict === "spills");
  return (
    <>
      <button type="button" className="crumb" onClick={() => setState({ addPage: false })}>
        <Icon id="left" cls="s14" />
        Models
      </button>
      <Head title="Download a model">
        Picked for your {gpuName}. Estimated at your default context, {k(numCtx)}.
      </Head>
      {catalog === NA ? (
        <p className="na">The model list is not available in this build. You can still type a model name below.</p>
      ) : null}
      {rec.length > 0 ? (
        <Grp title="Recommended">
          {rec.map((c) => (
            <DlRow key={c.name} c={c} numCtx={numCtx} />
          ))}
        </Grp>
      ) : null}
      {more.length > 0 ? (
        <Grp title={allSpill ? "Also available · uses system memory" : "Also available"}>
          {more.map((c) => (
            <DlRow key={c.name} c={c} numCtx={numCtx} />
          ))}
        </Grp>
      ) : null}
      <Grp title="Something else">{pullNA ? <Row label="Any model from the Ollama library" desc="Downloads are not available in this build." /> : <CustomPull />}</Grp>
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
  const v = runtime?.version ? ` · Ollama ${runtime.version}` : "";
  const stat =
    rt === "ready" ? `Running${v}` : rt === "installing" ? "Installing" : rt === "starting" ? "Starting" : rt === "missing" ? "Not installed" : rt === "wrong" ? `Port ${port} busy` : rt === "offline" ? "Reconnecting" : rt === "stopped" ? "Stopped" : "Didn't start";
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
  const total = (models ?? []).reduce((a, m) => a + m.sizeBytes, 0);
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
            <Row label={app ? "Switch to the system Ollama" : "Switch to Gates Local's copy"} desc={app ? "The one your system starts" : "A private copy it starts and stops"}>
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
                        Both read the same models folder, <span className="mono">~/.ollama/models</span>, so nothing downloads again.
                      </li>
                      <li>
                        Its copy stays in <span className="mono">~/.local/share/gates-local/ollama</span> until you remove it.
                      </li>
                      <li>Chats pause for a few seconds while it reconnects.</li>
                    </ul>
                  </>
                ) : (
                  <>
                    <b>Switch to Gates Local's own copy of Ollama?</b>
                    <ul>
                      <li>
                        Downloads Ollama into <span className="mono">~/.local/share/gates-local/ollama</span>.
                      </li>
                      <li>
                        It reads the same models folder, <span className="mono">~/.ollama/models</span>, so your {models?.length ?? 0} models don't download again.
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
                      void updateSettings({ runtimeMode: app ? "system" : "app" });
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
        <Row label="Models folder" desc={models ? `${models.length} models · ${gb(total)} on disk` : undefined}>
          <span className="path">~/.ollama/models</span>
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
  const on = settings !== NA && settings?.imageGen === true;
  const comfy = settings === NA ? undefined : settings?.comfyUrl;
  return (
    <>
      <Head title="Image generation">Off by default. When on, the model can queue image jobs in ComfyUI on this GPU.</Head>
      <Grp title="ComfyUI">
        <Row label="Generate images" desc={settings === NA ? NOT_HERE : on ? "On. The Image toggle in the message box turns it on for a chat." : "Off. The model can't queue image jobs."}>
          {settings === NA ? null : (
            <button
              type="button"
              className="switch"
              role="switch"
              aria-checked={on}
              aria-label="Generate images"
              onClick={() => void updateSettings({ imageGen: !on })}
            />
          )}
        </Row>
        <Row label="ComfyUI install" desc={status === NA ? NOT_HERE : status === undefined ? "Checking…" : `${IMAGE_WORDS[status.state] ?? ""}${status.detail ? ` ${status.detail}` : ""}`}>
          {status !== NA && status?.baseUrl ? <span className="path">{status.baseUrl}</span> : null}
        </Row>
        {settings !== NA && settings !== undefined ? (
          <Row label="ComfyUI address" desc="Where Gates Local finds ComfyUI.">
            <input
              className="inp"
              aria-label="ComfyUI address"
              placeholder="http://127.0.0.1:8188"
              value={url ?? comfy ?? ""}
              onChange={(e) => setUrl(e.target.value)}
              onBlur={() => {
                if (url === null) return;
                void updateSettings({ comfyUrl: url.trim() === "" ? null : url.trim() });
                setUrl(null);
              }}
            />
          </Row>
        ) : null}
      </Grp>
    </>
  );
}

function fresh(src: Source): string {
  if (src.state === "refreshing") return "Refreshing…";
  if (src.state === "error") return src.detail ?? "Couldn't read it.";
  const parts: string[] = [];
  if (src.sizeBytes !== undefined) parts.push(src.sizeBytes > 1024 ** 3 ? gb(src.sizeBytes) : `${Math.max(1, Math.round(src.sizeBytes / 1024 ** 2))} MB`);
  if (src.snapshotAt !== undefined) parts.push(`read ${new Date(src.snapshotAt).toLocaleDateString(undefined, { month: "short", day: "numeric" })}`);
  return parts.join(" · ") || "Read-only";
}

function SourceRow({ src }: { src: Source }) {
  return (
    <Row label={src.label || src.path} desc={`${src.kind === "sqlite" ? "SQLite · " : ""}${fresh(src)}`}>
      <span className="badge">read-only</span>
      <button type="button" className="qa" onClick={() => void refreshSource(src.id)}>
        Refresh
      </button>
      <button type="button" className="qa" onClick={() => void removeSource(src.id)}>
        Remove
      </button>
    </Row>
  );
}

/** "Add folder…" opens a path field: the browser cannot pick a folder path (desktop picker wanted). */
function AddSource({ kind, label, desc, button, icon }: { kind: "folder" | "file" | "sqlite"; label: string; desc: string; button: string; icon: "folder" | "file" | "db" }) {
  const [open, setOpen] = useState(false);
  const [path, setPath] = useState("");
  return (
    <Row label={label} desc={desc}>
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
              void addSource(kind, path);
              setPath("");
              setOpen(false);
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
  if (section === "models" && addPage) return <DownloadPage />;
  switch (section) {
    case "general":
      return <General />;
    case "models":
      return <Models />;
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
