// Settings (shell.md F20, F27, F45, F46, F59, F62-F66; the S1 council): one
// page per nav item, wired to settings.get/update and the v2 methods. Three
// control idioms only: a secondary button, a right-aligned value, and a ⋯ menu
// for what is rare or destructive. A control the server cannot back is left
// out instead of being shown switched off.
import { Suspense, lazy, useEffect, useRef, useState } from "react";
import type { Source, TextSize, Theme } from "@gates-local/contracts";
import { portOf, rtInfo, rtOf } from "./Banner.tsx";
import { GpuMemory } from "./FitPanel.tsx";
import { count, folderWords, gb, noGpu, sourceDetail } from "./format.ts";
import { Icon, type IconId } from "./icons.tsx";
import { ModelsPage } from "./Models.tsx";
import { addSource, checkImageStatus, dataFolder, openDataFolder, openSettings, refreshSource, removeSource, resetSettings, updateSettings } from "./session.ts";
import { NA, setState, useStore } from "./store.ts";
import { Fail, Grp, Head, Row, useAct, useOutside, walk } from "./settings-ui.tsx";
import { Updates } from "./Updates.tsx";

const Instructions = lazy(() => import("./Instructions.tsx"));

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

// ---------------------------------------------------------------- General

const THEME_WORDS: Record<Theme, string> = {
  dark: "Always dark.",
  light: "Always light.",
  system: "System matches your desktop's light or dark setting.",
};

const THEMES: readonly (readonly [Theme, string])[] = [
  ["dark", "Dark"],
  ["light", "Light"],
  ["system", "System"],
];

const TEXT_SIZES: readonly (readonly [TextSize, string])[] = [
  ["small", "Small"],
  ["default", "Default"],
  ["large", "Large"],
];

function General() {
  const settings = useStore((s) => s.settings);
  const unavailable = useStore((s) => s.unavailable["settings.update"] === true);
  const current = settings === NA ? undefined : settings;
  const [themeErr, runTheme] = useAct();
  const [textErr, runText] = useAct();
  return (
    <>
      <Head title="General" />
      {settings === NA || unavailable ? null : (
        <Grp title="Appearance">
          <Row label="Theme" desc={current === undefined ? undefined : THEME_WORDS[current.theme]} err={themeErr}>
            <Seg2 label="Theme" value={current?.theme} options={THEMES} onPick={(t) => void runTheme(updateSettings({ theme: t }))} />
          </Row>
          <Row label="Text size" desc="Applies to messages and the message box." err={textErr}>
            <Seg2 label="Text size" value={current === undefined ? undefined : (current.textSize ?? "default")} options={TEXT_SIZES} onPick={(t) => void runText(updateSettings({ textSize: t }))} />
          </Row>
        </Grp>
      )}
      <Updates />
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
        ? "Started by Gates Local. It stops when you quit."
        : "Started by your system. It keeps running when you quit Gates Local."
      : rt === "installing"
        ? "Installing Gates Local's own Ollama."
        : rt === "starting"
          ? "Waiting for Ollama to answer."
          : rt === "missing"
            ? runtime?.noAppCopy === true
              ? (runtime.detail ?? info.tip)
              : "No Ollama is installed. Gates Local can install its own."
            : rt === "wrong"
              ? `Something other than Ollama answers on port ${port}.`
              : (runtime?.detail ?? info.tip);
  const canSwitch = settings !== NA && settings !== undefined;
  // A runtime that cannot be used has no owner, so the mode chosen says which way a switch goes.
  const ownCopy = rt === "ready" || !canSwitch ? app : settings.runtimeMode === "app";
  const nothingToSwitchTo = !ownCopy && runtime?.noAppCopy === true;
  const [err, run] = useAct();
  const total = (models ?? []).reduce((a, m) => a + m.sizeBytes, 0);
  const folders = folderWords();
  return (
    <>
      <Head title="Runtime">Ollama is the program that runs your models. Gates Local finds it on its own.</Head>
      <Grp>
        <Row
          label={
            <span className="stat">
              <span className={`dot ${info.dot}`} />
              {stat}
            </span>
          }
          desc={
            <>
              {statD}
              {runtime?.baseUrl === undefined ? null : (
                <span className="d">
                  Ollama address <span className="mono">{runtime.baseUrl}</span>
                </span>
              )}
            </>
          }
        />
        {nothingToSwitchTo ? (
          <Row label="Gates Local's own Ollama" desc="Not available on this computer. Gates Local uses the Ollama your system runs." />
        ) : canSwitch && rt !== "installing" && rt !== "starting" && rt !== "offline" ? (
          <>
            <Row label={ownCopy ? "Using Gates Local's own Ollama" : "Using the system Ollama"} desc={ownCopy ? "A private Ollama that Gates Local installs, starts and stops." : "The Ollama your computer already has."} err={err}>
              <button type="button" className={`btn outline${confirm ? " pressed" : ""}`} aria-expanded={confirm} onClick={() => setState({ ownerConfirm: !confirm })}>
                {ownCopy ? "Use the system Ollama…" : "Use Gates Local's own Ollama…"}
              </button>
            </Row>
            {confirm ? (
              <div className="cfm" role="group" aria-label="Confirm switch">
                {ownCopy ? (
                  <>
                    <b>Go back to the system Ollama?</b>
                    <ul>
                      <li>The model in use stops and has to load again. Chats pause for a few seconds.</li>
                      <li>
                        The system Ollama reads its own folder, <span className="mono">{folders.models}</span>. Models you downloaded here stay in <span className="mono">{folders.appModels}</span>.
                      </li>
                      <li>
                        Gates Local's own Ollama stays in <span className="mono">{folders.appCopy}</span> until you remove it.
                      </li>
                    </ul>
                  </>
                ) : (
                  <>
                    <b>Use Gates Local's own Ollama?</b>
                    <ul>
                      <li>
                        Downloads Ollama into <span className="mono">{folders.appCopy}</span>.
                      </li>
                      <li>The model in use has to load again. Chats pause for about a minute while it installs and starts.</li>
                      <li>
                        Your models stay where they are, in <span className="mono">{folders.models}</span>. It keeps its own in <span className="mono">{folders.appModels}</span>, so a model you want there downloads again.
                      </li>
                      <li>It runs on port 11435. The system Ollama keeps running for other apps.</li>
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
                      void run(updateSettings({ runtimeMode: ownCopy ? "system" : "app" }));
                    }}
                  >
                    {ownCopy ? "Switch" : "Install and switch"}
                  </button>
                </div>
              </div>
            ) : null}
          </>
        ) : null}
        <Row label="Models folder" desc={models ? `${count(models.length, "model")} · ${gb(total)}` : undefined}>
          <span className="mono">{app ? folders.appModels : folders.models}</span>
        </Row>
      </Grp>
    </>
  );
}

// ---------------------------------------------------------------- Tools

function Tools() {
  const settings = useStore((s) => s.settings);
  const sources = useStore((s) => s.sources);
  const [err, run] = useAct();
  const on = settings === NA || settings?.tools === true;
  const nothingToRead = sources !== NA && sources !== undefined && sources.length === 0;
  const windows = /\bWindows\b/.test(navigator.userAgent);
  const library = on ? (
    <button type="button" className="btn outline" onClick={() => openSettings("library")}>
      Library
    </button>
  ) : (
    <span className="na">Off</span>
  );
  return (
    <>
      <Head title="Tools">What the model can do in a chat beyond writing a reply.</Head>
      {settings === NA || settings === undefined ? null : (
        <Grp>
          <Row label="Let the model use tools" desc={!on ? "Off. It answers from the conversation alone." : nothingToRead ? "On, but nothing is in your Library yet, so no tool is offered." : "On. It can use the tools below when a chat needs them."} err={err}>
            <button type="button" className="switch" role="switch" aria-checked={on} aria-label="Let the model use tools" onClick={() => void run(updateSettings({ tools: !on }))} />
          </Row>
        </Grp>
      )}
      <Grp>
        <Row label="Read files" desc="Reads the folders and files in your Library. It can't change them.">
          {library}
        </Row>
        {windows ? (
          <Row label="Query databases" desc="Looks things up in a copy of the SQLite databases in your Library.">
            {library}
          </Row>
        ) : (
          <Row label="Run commands" desc="Runs Linux commands in a sandbox that sees your Library read-only, with no home folder and no network.">
            {library}
          </Row>
        )}
        <Row label="Make images" desc="Uses ComfyUI, only in chats where you turn Image on.">
          <button type="button" className="btn outline" onClick={() => openSettings("images")}>
            Image generation
          </button>
        </Row>
      </Grp>
    </>
  );
}

// ---------------------------------------------------------------- Image generation

/** The status row: what ComfyUI is doing now and the one thing to do about it. */
function ImageState({ address }: { address: string }) {
  const status = useStore((s) => s.imageStatus);
  const [err, run] = useAct();
  if (status === NA) return null;
  const state = status === undefined || status.state === "off" ? "checking" : status.state;
  const word = { checking: "Checking", missing: "Not found", stopped: "Found", starting: "Starting", ready: "Connected", busy: "Making an image", error: "Something went wrong" }[state];
  const dot = state === "ready" || state === "busy" || state === "stopped" ? "ok" : state === "missing" || state === "error" ? "err" : "run";
  const desc =
    state === "missing"
      ? `ComfyUI did not answer at ${address}.`
      : state === "stopped"
        ? "It starts when a chat asks for an image."
        : state === "error"
          ? (status?.detail ?? "ComfyUI reported a problem.")
          : undefined;
  return (
    <Row
      label={
        <span className="stat">
          <span className={`dot ${dot}`} />
          {word}
        </span>
      }
      desc={desc}
      err={err}
    >
      {state === "missing" ? (
        <a className="btn outline" href="https://github.com/Calculator5329/gates-local/blob/main/docs/setup/linux.md#4-optional-image-generation-with-comfyui" target="_blank" rel="noreferrer noopener">
          How to set up
        </a>
      ) : state === "error" ? (
        <button type="button" className="btn outline" onClick={() => void run(checkImageStatus())}>
          Retry
        </button>
      ) : state === "ready" || state === "busy" ? (
        <a className="btn outline" href={status?.baseUrl ?? address} target="_blank" rel="noreferrer noopener">
          Open
        </a>
      ) : null}
    </Row>
  );
}

function Images() {
  const settings = useStore((s) => s.settings);
  const status = useStore((s) => s.imageStatus);
  const [url, setUrl] = useState<string | null>(null);
  const [testing, setTesting] = useState(false);
  const [genErr, runGen] = useAct();
  const [urlErr, runUrl] = useAct();
  const on = settings !== NA && settings?.imageGen === true;
  const comfy = settings === NA ? undefined : settings?.comfyUrl;
  const address = (status !== undefined && status !== NA ? status.baseUrl : undefined) ?? comfy ?? "http://127.0.0.1:8188";
  // the typed address stays until the server saved it (W-07)
  const save = async (): Promise<boolean> => {
    if (url === null) return true;
    const ok = await runUrl(updateSettings({ comfyUrl: url.trim() === "" ? null : url.trim() }));
    if (ok) setUrl(null);
    return ok;
  };
  const test = async () => {
    setTesting(true);
    if (await save()) await runUrl(checkImageStatus());
    setTesting(false);
  };
  return (
    <>
      <Head title="Image generation">Let the assistant make images on this computer. It uses ComfyUI, a separate free program you install yourself.</Head>
      {settings === NA || settings === undefined ? null : (
        <Grp>
          <Row label="Generate images" desc={on ? "The Image button in the message box turns it on for a chat. If the GPU is short, the chat model is unloaded while an image renders." : undefined} err={genErr}>
            <button type="button" className="switch" role="switch" aria-checked={on} aria-label="Generate images" onClick={() => void runGen(updateSettings({ imageGen: !on }))} />
          </Row>
        </Grp>
      )}
      {on ? (
        <Grp title="Connection">
          <ImageState address={address} />
          <Row label="ComfyUI address" err={urlErr}>
            <input className="inp" aria-label="ComfyUI address" placeholder="http://127.0.0.1:8188" value={url ?? comfy ?? ""} onChange={(e) => setUrl(e.target.value)} onBlur={() => void save()} />
            <button type="button" className="btn outline" disabled={testing} onClick={() => void test()}>
              {testing ? "Testing…" : "Test"}
            </button>
          </Row>
        </Grp>
      ) : null}
    </>
  );
}

// ---------------------------------------------------------------- Library

type SourceKind = Source["kind"];

const ADD_WORDS: Record<SourceKind, { noun: string; hint: string }> = {
  folder: { noun: "folder", hint: "~/docs" },
  file: { noun: "file", hint: "~/notes/todo.md" },
  sqlite: { noun: "database", hint: "~/docs/library.db" },
};

const KIND_ICON: Record<SourceKind, IconId> = { folder: "folder", file: "file", sqlite: "db" };

function SourceRow({ src }: { src: Source }) {
  const [open, setOpen] = useState(false);
  const [err, run] = useAct();
  const box = useRef<HTMLDivElement>(null);
  const btn = useRef<HTMLButtonElement>(null);
  const name = src.label || src.path;
  const close = (refocus = true) => {
    setOpen(false);
    if (refocus) btn.current?.focus();
  };
  useOutside(box, open, () => close(false));
  useEffect(() => {
    if (open) box.current?.querySelector<HTMLElement>("[role=menuitem]")?.focus();
  }, [open]);
  const broken = src.state === "error";
  return (
    <div className="srow src">
      <Icon id={KIND_ICON[src.kind]} cls="src-ic" />
      <div className="sl">
        <b>{name}</b>
        {src.label && src.label !== src.path ? <span className="d mono">{src.path}</span> : null}
        {broken ? <span className="act-err">{sourceDetail(src)}</span> : null}
        <Fail err={err} />
      </div>
      <div className="sv">
        <span className="src-d">{broken ? "Unavailable" : sourceDetail(src)}</span>
        <div className="mp-acts" ref={box} onKeyDown={(e) => open && walk(e, box.current, "[role=menuitem]", close)}>
          <button ref={btn} type="button" className={`mp-kebab${open ? " on" : ""}`} aria-label={`More for ${name}`} aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen(!open)}>
            <Icon id="more" />
          </button>
          {open ? (
            <div className="mp-menu src-menu" role="menu">
              {src.kind === "sqlite" || broken ? (
                <button
                  type="button"
                  role="menuitem"
                  className="mp-mi"
                  onClick={() => {
                    close();
                    void run(refreshSource(src.id));
                  }}
                >
                  Refresh
                </button>
              ) : null}
              <button
                type="button"
                role="menuitem"
                className="mp-mi danger"
                onClick={() => {
                  close();
                  void run(removeSource(src.id));
                }}
              >
                Remove
              </button>
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}

/** The path field an Add button opens: the browser cannot pick a path. */
function AddRow({ kind, close }: { kind: SourceKind; close: () => void }) {
  const [path, setPath] = useState("");
  const [err, run] = useAct();
  const input = useRef<HTMLInputElement>(null);
  const { noun, hint } = ADD_WORDS[kind];
  useEffect(() => input.current?.focus(), []);
  return (
    <Row label={`Add a ${noun}`} err={err}>
      <input
        ref={input}
        className="inp"
        aria-label={`Add a ${noun} path`}
        placeholder={hint}
        value={path}
        onChange={(e) => setPath(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            e.stopPropagation();
            close();
          }
        }}
      />
      <button
        type="button"
        className="btn outline"
        disabled={path.trim() === ""}
        // the form keeps the typed path until the server added it (W-07)
        onClick={() => void run(addSource(kind, path)).then((ok) => ok && close())}
      >
        Add
      </button>
    </Row>
  );
}

function SourceGroup({ title, desc, none, kinds, items }: { title: string; desc: string; none: string; kinds: readonly SourceKind[]; items: readonly Source[] }) {
  const [adding, setAdding] = useState<SourceKind | null>(null);
  const action = kinds.map((kind) => (
    <button key={kind} type="button" className="btn outline" onClick={() => setAdding(kind)}>
      Add {ADD_WORDS[kind].noun}…
    </button>
  ));
  return (
    <Grp title={title} desc={desc} action={action}>
      {adding === null ? null : <AddRow key={adding} kind={adding} close={() => setAdding(null)} />}
      {items.map((x) => (
        <SourceRow key={x.id} src={x} />
      ))}
      {items.length === 0 && adding === null ? <div className="src-none">{none}</div> : null}
    </Grp>
  );
}

function Library() {
  const sources = useStore((s) => s.sources);
  const list = sources === NA || sources === undefined ? [] : sources;
  return (
    <>
      <Head title="Library">Folders, files and databases the model can read in every chat. Gates Local never changes them.</Head>
      {sources === NA ? null : (
        <>
          <SourceGroup title="Files and folders" desc="Read as they are now." none="No folders or files yet. Add one and the model can read it." kinds={["folder", "file"]} items={list.filter((x) => x.kind !== "sqlite")} />
          <SourceGroup title="SQLite databases" desc="Read from a copy made when you add one." none="No databases yet. Add a SQLite file and the model can look things up in it." kinds={["sqlite"]} items={list.filter((x) => x.kind === "sqlite")} />
        </>
      )}
    </>
  );
}

// ---------------------------------------------------------------- Advanced

/** Only the desktop window knows this folder and can open it. */
function DataFolder() {
  const [path, setPath] = useState<string | null>(null);
  const [err, run] = useAct();
  useEffect(() => {
    let live = true;
    void dataFolder().then((p) => {
      if (live) setPath(p);
    });
    return () => {
      live = false;
    };
  }, []);
  if (path === null) return null;
  return (
    <Row label="Data folder" desc={<span className="mono">{path}</span>} err={err}>
      <button type="button" className="btn outline" onClick={() => void run(openDataFolder())}>
        Open folder
      </button>
    </Row>
  );
}

function ResetSettings() {
  const [asking, setAsking] = useState(false);
  const [err, run] = useAct();
  return (
    <>
      <Row label="Reset settings" desc="Put every setting back to how it started." err={err}>
        <button type="button" className={`btn outline${asking ? " pressed" : ""}`} aria-expanded={asking} onClick={() => setAsking(!asking)}>
          Reset…
        </button>
      </Row>
      {asking ? (
        <div className="cfm" role="group" aria-label="Confirm reset">
          <b>Reset every setting?</b>
          <ul>
            <li>Theme, text size, default model, context, tools and image generation go back to how they started.</li>
            <li>Shared instructions, model instructions and reply controls are cleared.</li>
            <li>Your chats, Library and downloaded models stay.</li>
            <li>Which Ollama Gates Local uses stays as it is.</li>
          </ul>
          <div className="ca">
            <button type="button" className="btn ghost" onClick={() => setAsking(false)}>
              Cancel
            </button>
            <button
              type="button"
              className="btn primary"
              onClick={() => {
                setAsking(false);
                void run(resetSettings());
              }}
            >
              Reset
            </button>
          </div>
        </div>
      ) : null}
    </>
  );
}

function Advanced() {
  const cpu = useStore((s) => noGpu(s.gpu));
  const canReset = useStore((s) => s.settings !== NA && s.unavailable["settings.update"] !== true);
  return (
    <>
      <Head title="Advanced" />
      <Grp title={cpu ? "System memory" : "GPU memory"}>
        <GpuMemory />
      </Grp>
      <Grp>
        <DataFolder />
        {canReset ? <ResetSettings /> : null}
      </Grp>
    </>
  );
}

// ---------------------------------------------------------------- Shortcuts

/** The bindings App.tsx, Sidebar.tsx and Composer.tsx really handle. */
const SHORTCUTS: readonly (readonly [string, readonly (readonly [string, readonly string[]])[]])[] = [
  [
    "Navigation",
    [
      ["New thread", ["Ctrl", "N"]],
      ["Search threads", ["Ctrl", "K"]],
      ["Choose a model", ["Ctrl", "M"]],
      ["Settings", ["Ctrl", ","]],
      ["Close a menu or Settings", ["Esc"]],
      ["Open a thread's menu", ["Shift", "F10"]],
    ],
  ],
  [
    "Chat",
    [
      ["Send", ["Enter"]],
      ["New line", ["Shift", "Enter"]],
    ],
  ],
];

function Shortcuts() {
  return (
    <>
      <Head title="Shortcuts" />
      {SHORTCUTS.map(([group, rows]) => (
        <Grp key={group} title={group}>
          <table className="kl">
            <tbody>
              {rows.map(([what, keys]) => (
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
      ))}
    </>
  );
}

export function SettingsView() {
  const section = useStore((s) => s.section);
  switch (section) {
    case "general":
      return <General />;
    case "models":
      return <ModelsPage />;
    case "instructions":
      return <Suspense fallback={<><Head title="Instructions" /><div className="inst-status" role="status">Loading…</div></>}><Instructions /></Suspense>;
    case "library":
      return <Library />;
    case "tools":
      return <Tools />;
    case "images":
      return <Images />;
    case "runtime":
      return <Runtime />;
    case "advanced":
      return <Advanced />;
    case "shortcuts":
      return <Shortcuts />;
  }
}
