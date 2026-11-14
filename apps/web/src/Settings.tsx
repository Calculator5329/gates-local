// Settings (shell.md F20, F27, F45, F46, F59, F62-F66; the S1 council): one
// page per nav item, wired to settings.get/update and the v2 methods. Three
// control idioms only: a secondary button, a right-aligned value, and a ⋯ menu
// for what is rare or destructive. A control the server cannot back is left
// out instead of being shown switched off.
import { type CSSProperties, useEffect, useRef, useState } from "react";
import type { Accent, ImageStatus, ShellStatus, Source, Theme } from "@gates-local/contracts";
import { portOf, rtInfo, rtOf } from "./Banner.tsx";
import { GpuMemory } from "./FitPanel.tsx";
import { count, folderWords, noGpu, sourceDetail } from "./format.ts";
import { handleKey } from "./handles.ts";
import { Icon, type IconId } from "./icons.tsx";
import LibraryImports from "./LibraryImports.tsx";
import { ModelsPage } from "./Models.tsx";
import { sizeText } from "./models-rules.ts";
import { addSource, canOpenFolder, checkImageStatus, checkShell, dataFolder, openDataFolder, openSettings, refreshSource, removeSource, resetSettings, settingsReads, updateSettings } from "./session.ts";
import { NA, setState, useStore } from "./store.ts";
import { CopyButton, PathText, Status } from "./settings-controls.tsx";
import { type LibraryTool, libraryToolCanUse } from "./settings-rules.ts";
import { COMPUTER_ONLY, Fail, Grp, Head, Na, Row, Seg2, Skel, useAct, useOutside, walk } from "./settings-ui.tsx";
import { Updates } from "./SettingsUpdates.tsx";
import Instructions from "./Instructions.tsx";
import { VoiceSettings } from "./VoiceSettings.tsx";
import { closeTip, esc } from "./ui.tsx";

// Voice to text and Instructions ship in the Settings chunk: a section that
// suspends shows its fallback and then the real cards ~300 ms later (docs/design.md).

// ---------------------------------------------------------------- General

const THEMES: readonly (readonly [Theme, string])[] = [
  ["dark", "Dark"],
  ["light", "Light"],
  ["system", "System"],
];

const ACCENTS: readonly (readonly [Accent, string])[] = [
  ["neutral", "Neutral"],
  ["green", "Green"],
  ["blue", "Blue"],
  ["violet", "Violet"],
  ["amber", "Amber"],
  ["red", "Red"],
];

/** One dot per accent in this theme's own step of it; the picked one is ringed. */
function Swatches({ value, onPick }: { value: Accent | undefined; onPick: (a: Accent) => void }) {
  return (
    <span className="swatches" role="group" aria-label="Accent">
      {ACCENTS.map(([a, name]) => (
        <button key={a} type="button" className="swatch" data-testid={`settings.appearance.accent-${a}`} aria-label={name} aria-pressed={a === value} data-tip={name} style={{ "--sw": a === "neutral" ? "var(--foreground)" : `var(--accent-${a})` } as CSSProperties} onClick={() => onPick(a)} />
      ))}
    </span>
  );
}

function General() {
  const settings = useStore((s) => s.settings);
  const unavailable = useStore((s) => s.unavailable["settings.update"] === true);
  const current = settings === NA ? undefined : settings;
  const [themeErr, runTheme] = useAct();
  const [accentErr, runAccent] = useAct();
  return (
    <>
      <Head title="General" />
      {settings === NA || unavailable ? null : (
        <Grp title="Appearance">
          <Row label="Theme" tip="System follows your desktop's light or dark setting." err={themeErr}>
            <Seg2 label="Theme" handle="theme" value={current?.theme} options={THEMES} onPick={(t) => void runTheme(updateSettings({ theme: t }))} />
          </Row>
          <Row label="Accent" tip="The colour of the mark on the start screen." err={accentErr}>
            <Swatches value={current === undefined ? undefined : (current.accent ?? "neutral")} onPick={(a) => void runAccent(updateSettings({ accent: a }))} />
          </Row>
        </Grp>
      )}
      <Updates />
      <VoiceSettings />
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
        ? "Gates Local's own Ollama. It starts and stops with the app."
        : "The Ollama your computer runs. It keeps running when you quit Gates Local."
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
  const [openErr, runOpen] = useAct();
  const total = (models ?? []).reduce((a, m) => a + m.sizeBytes, 0);
  const folders = folderWords();
  const [knownFolder, setKnownFolder] = useState<string | null>(null);
  useEffect(() => {
    let current = true;
    setKnownFolder(null);
    if (app && runtime?.state === "ready") {
      void window.gatesLocal?.modelsFolder?.().then(folder => { if (current) setKnownFolder(folder); }).catch(() => undefined);
    }
    return () => { current = false; };
  }, [app, runtime?.state, runtime?.modelsDir, runtime?.baseUrl]);
  // Desktop uses main's verified ownership record. A browser can only copy the server-reported path.
  const folder = window.gatesLocal === undefined ? runtime?.modelsDir : app && runtime?.state === "ready" ? knownFolder ?? undefined : undefined;
  const locked = useStore((s) => s.unavailable["settings.update"] === true);
  const switchable = !locked && !nothingToSwitchTo && canSwitch && rt !== "installing" && rt !== "starting" && rt !== "offline";
  return (
    <>
      <Head title="Runtime" />
      <Grp>
        <Row label={<Status dot={info.dot}>{stat}</Status>} desc={statD} err={err}>
          {switchable ? (
            <button type="button" className={`btn outline${confirm ? " pressed" : ""}`} data-testid="settings.runtime.switch" aria-expanded={confirm} onClick={() => setState({ ownerConfirm: !confirm })}>
              {ownCopy ? "Use the system Ollama" : "Use Gates Local's Ollama"}
            </button>
          ) : null}
        </Row>
        {nothingToSwitchTo ? <Row label="Gates Local's own Ollama" desc="Not available on this computer." /> : null}
        {switchable && confirm ? (
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
                  <li>It starts when Gates Local starts and stops when you quit.</li>
                  <li>Installing downloads Ollama. The model in use has to load again, and chats pause for about a minute while it installs and starts.</li>
                  <li>It keeps its own models, so a model you want there downloads again. Your models stay where they are.</li>
                  <li>
                    Ollama goes in <span className="mono">{folders.appCopy}</span>, its models in <span className="mono">{folders.appModels}</span>. Yours are in <span className="mono">{folders.models}</span>.
                  </li>
                  <li>It runs on port 11435. The system Ollama keeps running for other apps.</li>
                </ul>
              </>
            )}
            <div className="ca">
              <button type="button" className="btn ghost" data-testid="settings.runtime.switch-cancel" onClick={() => setState({ ownerConfirm: false })}>
                Cancel
              </button>
              <button
                type="button"
                className="btn primary"
                data-testid="settings.runtime.switch-confirm"
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
        {runtime?.baseUrl === undefined ? null : (
          <Row label="Ollama address" desc={<span className="mono">{runtime.baseUrl.replace(/^https?:\/\//, "")}</span>}>
            <CopyButton text={runtime.baseUrl} label="Copy Ollama address" handle="ollama-address" />
          </Row>
        )}
        {folder === undefined && !models ? null : (
          <Row
            label={folder === undefined ? "Models" : "Models folder"}
            desc={
              <>
                {folder === undefined ? null : <PathText path={folder} />}
                {models ? <span className="d">{`${count(models.length, "model")} · ${sizeText(total)}`}</span> : null}
              </>
            }
            err={openErr}
          >
            {folder !== undefined && canOpenFolder() ? (
              <button type="button" className="btn outline" data-testid="settings.runtime.open-models-folder" aria-label="Open models folder" onClick={() => void runOpen(window.gatesLocal?.openModelsFolder?.() ?? Promise.resolve(null))}>
                Open
              </button>
            ) : null}
            {folder === undefined ? null : <CopyButton text={folder} label="Copy models folder path" handle="models-folder" />}
          </Row>
        )}
      </Grp>
    </>
  );
}

// ---------------------------------------------------------------- Tools

interface ToolState {
  readonly word: string;
  readonly dot: string;
  /** Not offered to the model right now. */
  readonly dim?: boolean;
  /** The page that fixes or configures it. */
  readonly go?: () => void;
}

/** One tool: its own readiness on the right, and the whole row a link to where that is changed. */
function ToolRow({ tool, name, desc, state }: { tool: LibraryTool; name: string; desc: string; state: ToolState }) {
  const cls = `srow tool${state.dim === true ? " dim" : ""}`;
  const inner = (
    <>
      <span className="sl">
        <b>{name}</b>
        <span className="d">{desc}</span>
      </span>
      <span className="sv">
        <Status dot={state.dot}>{state.word}</Status>
        {state.go === undefined ? null : <Icon id="right" cls="s14" />}
      </span>
    </>
  );
  return state.go === undefined ? (
    <div className={cls}>{inner}</div>
  ) : (
    <button type="button" className={cls} data-testid={`settings.tools.open-${tool}`} onClick={state.go}>
      {inner}
    </button>
  );
}

const quiet = (word: string): ToolState => ({ word, dot: "off", dim: true });

/** What the server offers (apps/server/src/app.ts): file tools need the switch and a ready Library source that tool can read. */
function libraryTool(on: boolean, sources: readonly Source[] | "na" | undefined, tool: LibraryTool, missing: string): ToolState {
  if (!on) return quiet("Turned off");
  if (sources === undefined) return { word: "Checking", dot: "run" };
  if (sources === NA) return quiet("Not available");
  // One word for one state (audit W03): an empty Library reads the same on every row.
  return { ...(libraryToolCanUse(tool, sources) ? { word: "Ready", dot: "ok" } : quiet(sources.length === 0 ? "Library empty" : missing)), go: () => openSettings("library") };
}

/** Run commands also needs its sandbox: Ready only after the server's probe ran a command in it (tools.shell). */
function runTool(on: boolean, sources: readonly Source[] | "na" | undefined, shell: ShellStatus | "na" | undefined): ToolState {
  if (!on) return quiet("Turned off");
  if (shell === undefined) return { word: "Checking", dot: "run" };
  if (shell === NA) return quiet("Not available");
  // What the machine lacks comes first: adding to the Library would not fix it.
  if (shell.state === "off") return quiet(shell.word ?? "Not available");
  const state = libraryTool(on, sources, "run", "Library empty");
  // Ready, but short of something (no sqlite3: database reads fail): the server's own words, in amber.
  return shell.word !== undefined && state.word === "Ready" ? { ...state, word: shell.word, dot: "warn" } : state;
}

function Tools() {
  const settings = useStore((s) => s.settings);
  const locked = useStore((s) => s.unavailable["settings.update"] === true);
  const sources = useStore((s) => s.sources);
  const status = useStore((s) => s.imageStatus);
  const [err, run] = useAct();
  const on = settings === NA || settings?.tools === true;
  const windows = /\bWindows\b/.test(navigator.userAgent);
  const shell = useStore((s) => s.shellStatus);
  // Asked each time Tools opens: the server keeps a passed probe and asks a failed one again.
  useEffect(() => { if (!windows) checkShell(); }, [windows]);
  const [imageErr, runImage] = useAct();
  // The chat model's image tool: app-wide, offered only with the master switch on. Unset is on once a
  // setup can run (ComfyUI listed every file for one, and the card has room), as the server reads it.
  // The composer's Image button sends to the image model itself and never needs it.
  const image = imageFace(status);
  const presets = useStore((s) => s.imagePresets);
  const runnable = presets !== NA && presets !== undefined && presets.presets.length > 0 && presets.noGpu === undefined;
  const imageTool = settings !== NA && settings !== undefined && (settings.imageTool ?? (settings.imageGen && runnable));
  // Why it cannot be turned on with the master switch on; both sentences hold one cell, so the
  // row keeps its height when the switch above flips.
  // Both fixes are in Image generation: the reason goes there, as every Tools row goes where it is fixed.
  // The same button in both sentences, so the cell keeps one height on touch (a link is 44 px there);
  // while its sentence is the hidden one it is invisible and out of the tab order.
  const fixIt = <button type="button" className="link" data-go="images" data-testid="settings.tools.image-setup" tabIndex={on ? undefined : -1} onClick={() => openSettings("images")}>Image generation</button>;
  const onWhy = settings === NA || settings?.imageGen !== true ? <>Needs Generate images, in {fixIt}.</>
    : status === NA ? "Not available in this build."
    : !image.usable ? <>ComfyUI: {image.word}. Set it up in {fixIt}.</>
    : null;
  const imageWhy = on ? onWhy : "Needs the switch above.";
  return (
    <>
      <Head title="Tools" />
      {/* Audit W03 (B1): the switch sits on the title of the one card it turns on; off dims the rows. */}
      <Grp title="Tools" action={settings === NA || settings === undefined ? undefined
        : locked ? <Status dot={on ? "ok" : "off"}>{on ? "On" : "Off"}</Status>
        : <button type="button" className="switch" role="switch" data-testid="settings.tools.enable" aria-checked={on} aria-label="Let the model use tools" data-tip="Let the model use tools" onClick={() => void run(updateSettings({ tools: !on }))} />}>
        <ToolRow tool="read" name="Read files" desc="Reads the folders and files in your Library. It can't change them." state={libraryTool(on, sources, "read", "No folders or files")} />
        {windows ? (
          <ToolRow tool="query" name="Query databases" desc="Looks things up in a copy of the SQLite databases in your Library." state={libraryTool(on, sources, "query", "No databases")} />
        ) : (
          <ToolRow tool="run" name="Run commands" desc="Runs Linux commands in a sandbox that sees your Library read-only, with no home folder and no network." state={runTool(on, sources, shell)} />
        )}
        <div className={`srow tool${imageWhy === null ? "" : " dim"}`} data-tool="images">
          <span className="sl">
            <b>Make images</b>
            <span className="d"><span className="steady">
              <span aria-hidden={on}>Needs the switch above.</span>
              <span aria-hidden={!on}>{onWhy ?? "It can make a picture with the image model picked in the message box."}</span>
            </span></span>
            <Fail err={imageErr} />
          </span>
          <span className="sv">
            {settings === NA ? null
              // a phone cannot change settings: the row says what the computer set, and its dot whether
              // the tool is offered now (the reason why not is the line beside it)
              : locked ? <Status dot={imageTool && imageWhy === null ? "ok" : "off"}>{imageTool ? "On" : "Off"}</Status>
              : <button type="button" className="switch" role="switch" data-testid="settings.tools.make-images" aria-checked={imageTool} aria-label="Make images" disabled={imageWhy !== null} onClick={() => void runImage(updateSettings({ imageTool: !imageTool }))} />}
          </span>
        </div>
      </Grp>
      <Fail err={err} line />
    </>
  );
}

// ---------------------------------------------------------------- Image generation

const SETUP_URL = "https://github.com/Calculator5329/gates-local/blob/main/docs/setup/linux.md#4-optional-image-generation-with-comfyui";

const SetupLink = () => (
  <a className="btn outline" href={SETUP_URL} data-testid="settings.images.setup-guide" target="_blank" rel="noreferrer noopener">
    How to set up
  </a>
);

/** ComfyUI's state in words, for this page's status row and the Tools row. */
function imageFace(status: ImageStatus | "na" | undefined) {
  const state = status === undefined || status === NA || status.state === "off" ? "checking" : status.state;
  const word = { checking: "Checking", missing: "Not connected", stopped: "Found", starting: "Starting", ready: "Connected", busy: "Making an image", error: "Something went wrong" }[state];
  const usable = state === "ready" || state === "busy" || state === "stopped";
  // ComfyUI not being there is a thing to set up; only a real error is red
  return { state, word, usable, dot: usable ? "ok" : state === "error" ? "err" : state === "missing" ? "warn" : "run" };
}

/** The status row: what ComfyUI is doing now and the one thing to do about it. */
function ImageState({ address }: { address: string }) {
  const status = useStore((s) => s.imageStatus);
  const [err, run] = useAct();
  if (status === NA) return null;
  const { state, word, dot } = imageFace(status);
  // Not connected says no more: the address it tried is in the field below (audit W08).
  const desc =
    state === "stopped"
        ? "It starts when a chat asks for an image."
        : state === "error"
          ? (status?.detail ?? "ComfyUI reported a problem.")
          : undefined;
  return (
    <Row label={<Status dot={dot}>{word}</Status>} desc={desc} err={err}>
      {state === "error" ? (
        <button type="button" className="btn outline" data-testid="settings.images.retry" onClick={() => void run(checkImageStatus())}>
          Retry
        </button>
      ) : state === "ready" || state === "busy" ? (
        <a className="btn outline" href={status?.baseUrl ?? address} data-testid="settings.images.open-comfyui" target="_blank" rel="noreferrer noopener">
          Open
        </a>
      ) : null}
    </Row>
  );
}

function Images() {
  const settings = useStore((s) => s.settings);
  const locked = useStore((s) => s.unavailable["settings.update"] === true);
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
      <Head title="Image generation" />
      {settings === NA || settings === undefined ? null : (
        <Grp>
          <Row label="Generate images" desc={locked ? `${on ? "On" : "Off"}. ${COMPUTER_ONLY}` : "If the GPU is short, the chat model is unloaded while an image renders."} tip="Images are made on this computer. Turn Image on in a chat's message box." err={genErr}>
            {locked ? null : <button type="button" className="switch" role="switch" data-testid="settings.images.enable" aria-checked={on} aria-label="Generate images" onClick={() => void runGen(updateSettings({ imageGen: !on }))} />}
          </Row>
          <Row label="Set up ComfyUI">
            <SetupLink />
          </Row>
        </Grp>
      )}
      {on ? (
        <Grp title="Connection">
          <ImageState address={address} />
          {locked ? null : (
            <Row label="ComfyUI address" err={urlErr}>
              <input className="inp" data-testid="settings.images.address" aria-label="ComfyUI address" placeholder="http://127.0.0.1:8188" value={url ?? comfy ?? ""} onChange={(e) => setUrl(e.target.value)} onBlur={() => void save()} />
              <button type="button" className="btn outline" data-testid="settings.images.test-connection" disabled={testing} onClick={() => void test()}>
                <span className="steady">
                  <span aria-hidden={testing}>Test connection</span>
                  <span aria-hidden={!testing}>Testing…</span>
                </span>
              </button>
            </Row>
          )}
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

/** A cloned repository's line: "Copied from owner/repo on Nov 13". The model reads that copy; it never refreshes. */
export const copiedFrom = (key: string, at: number) =>
  `Copied from ${key.replace(/^https:\/\/github\.com\//i, "").replace(/\.git\/?$|\/$/g, "")} on ${new Date(at).toLocaleDateString(undefined, { month: "short", day: "numeric" })}`;

function SourceRow({ src }: { src: Source }) {
  const locked = useStore((s) => s.unavailable["sources.remove"] === true);
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
  const detail = broken ? "Unavailable" : sourceDetail(src);
  return (
    <div className="srow src">
      <Icon id={KIND_ICON[src.kind]} cls="src-ic" />
      <div className="sl">
        <b>{name}</b>
        {src.managed ? <span className="d">{src.managed.kind === "sample" ? "Sample database" : copiedFrom(src.managed.key, src.addedAt)}</span> : src.label && src.label !== src.path ? <span className="d"><PathText path={src.path} /></span> : null}
        {broken ? <span className="act-err">{sourceDetail(src)}</span> : null}
        <Fail err={err} />
      </div>
      <div className="sv">
        {detail === "" ? null : <span className="src-d">{detail}</span>}
        {locked ? null : (
          <div className="mp-acts" data-testid={`settings.source.actions-${handleKey(src.id)}`} ref={box} onKeyDown={(e) => open && walk(e, box.current, "[role=menuitem]", close)}>
            <button ref={btn} type="button" className={`mp-kebab${open ? " on" : ""}`} data-testid={`settings.source.more-${handleKey(src.id)}`} aria-label={`More for ${name}`} aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen(!open)}>
              <Icon id="more" />
            </button>
            {open ? (
              <div className="mp-menu src-menu" role="menu">
                {src.kind === "sqlite" || broken ? (
                  <button
                    type="button"
                    role="menuitem"
                    className="mp-mi"
                    data-testid={`settings.source.refresh-${handleKey(src.id)}`}
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
                  data-testid={`settings.source.remove-${handleKey(src.id)}`}
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
        )}
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
    <Row label={`Add a ${noun}`} desc={<span className={err ? "src-help act-err" : "src-help"} role={err ? "alert" : undefined} data-tip={err ? esc(err) : undefined}>{err ?? "Choose a local path to share."}</span>}>
      <input
        ref={input}
        className="inp"
        data-testid={`settings.add-source.path-${kind}`}
        aria-label={`Add a ${noun} path`}
        aria-invalid={err !== null}
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
        data-testid={`settings.add-source.add-${kind}`}
        disabled={path.trim() === ""}
        // the form keeps the typed path until the server added it (W-07)
        onClick={() => void run(addSource(kind, path)).then((ok) => ok && close())}
      >
        Add
      </button>
      <button type="button" className="btn outline" data-testid={`settings.add-source.cancel-${kind}`} aria-label="Cancel adding source" data-tip="Cancel" onClick={close}>
        <Icon id="x" />
      </button>
    </Row>
  );
}

function SourceGroup({ title, kinds, items }: { title: string; kinds: readonly SourceKind[]; items: readonly Source[] }) {
  const locked = useStore((s) => s.unavailable["sources.add"] === true);
  const [adding, setAdding] = useState<SourceKind | null>(null);
  const entry = useRef<HTMLDivElement>(null);
  const close = () => {
    const kind = adding;
    closeTip();
    setAdding(null);
    requestAnimationFrame(() => entry.current?.querySelector<HTMLButtonElement>(`[data-add="${kind}"]`)?.focus({ preventScroll: true }));
  };
  const action = kinds.map((kind) => (
    <button key={kind} type="button" className="btn outline" data-add={kind} data-testid={`settings.library.add-${kind}`} onClick={() => setAdding(kind)}>
      Add {ADD_WORDS[kind].noun}…
    </button>
  ));
  return (
    <Grp title={title}>
      {items.map((x) => (
        <SourceRow key={x.id} src={x} />
      ))}
      <div className="src-entry" ref={entry}>
        {adding === null ? (
          // the line is what sets folders and files apart (clones sit under Clone), and it keeps this row the add form's height
          <Row label={items.length > 0 ? "Add another source" : "No folders or files yet."} desc={<span className="src-help">The model always sees the latest version.</span>}>
            {locked ? <Na>{COMPUTER_ONLY}</Na> : action}
          </Row>
        ) : <AddRow key={adding} kind={adding} close={close} />}
      </div>
    </Grp>
  );
}

/** The last row of Databases: a SQLite file of the person's own. */
function AddDatabase() {
  const locked = useStore((s) => s.unavailable["sources.add"] === true);
  const [adding, setAdding] = useState(false);
  const entry = useRef<HTMLDivElement>(null);
  const close = () => {
    closeTip();
    setAdding(false);
    requestAnimationFrame(() => entry.current?.querySelector<HTMLButtonElement>('[data-add="sqlite"]')?.focus({ preventScroll: true }));
  };
  return (
    <div className="src-entry" ref={entry}>
      {adding ? <AddRow kind="sqlite" close={close} /> : (
        <Row label="Add a database" desc={<span className="src-help">A SQLite file of your own.</span>}>
          {locked ? <Na>{COMPUTER_ONLY}</Na> : (
            <button type="button" className="btn outline" data-add="sqlite" data-testid="settings.library.add-sqlite" onClick={() => setAdding(true)}>
              Add database…
            </button>
          )}
        </Row>
      )}
    </div>
  );
}

function Library() {
  const sources = useStore((s) => s.sources);
  const locked = useStore((s) => s.unavailable["sources.add"] === true);
  // As the server reads it (app.ts): the Library reaches a turn only while Tools are on.
  const tools = useStore((s) => s.settings === NA || s.settings?.tools === true);
  const list = sources === NA || sources === undefined ? [] : sources;
  // A clone is a copy made once: it sits under Clone with where and when it came from, not among the folders the model sees change.
  const clones = list.filter((x) => x.managed?.kind === "repository");
  return (
    <>
      {/* Audit W07 and M04: no subtitle; only Tools off, which stops every read, is said, with its fix. */}
      <Head title="Library">
        {tools ? undefined : (
          <>
            Tools are off, so no chat reads these.{" "}
            <button type="button" className="link" onClick={() => openSettings("tools")}>Turn on Tools</button>
          </>
        )}
      </Head>
      {sources === NA ? null : (
        <>
          <LibraryImports add={<AddDatabase />} clone={!locked} clones={clones.map((x) => <SourceRow key={x.id} src={x} />)} />
          <SourceGroup title="Files and folders" kinds={["folder", "file"]} items={list.filter((x) => x.kind !== "sqlite" && x.managed?.kind !== "repository")} />
        </>
      )}
    </>
  );
}

// ---------------------------------------------------------------- Advanced

/** Only the desktop app has one. Read before Settings opens (session/settings-reads.ts); a placeholder row if not yet. */
function DataFolder() {
  const [path, setPath] = useState<string | null | undefined>(() => settingsReads.folder() ?? (window.gatesLocal?.dataFolder === undefined ? null : undefined));
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
  if (path === undefined) return <Row label="Data folder" desc={<Skel w="24em" />} busy><Skel w="7em" /></Row>;
  return (
    <Row label="Data folder" desc={<span className="mono">{path}</span>} err={err}>
      <button type="button" className="btn outline" data-testid="settings.advanced.open-data-folder" onClick={() => void run(openDataFolder())}>
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
      <Row label="Reset settings" desc="Your chats, Library and models stay." err={err}>
        <button type="button" className={`btn outline${asking ? " pressed" : ""}`} data-testid="settings.advanced.reset" aria-expanded={asking} onClick={() => setAsking(!asking)}>
          Reset…
        </button>
      </Row>
      {asking ? (
        <div className="cfm" role="group" aria-label="Confirm reset">
          <b>Reset every setting?</b>
          <ul>
            <li>Theme, accent, default model, context, tools and image generation go back to how they started.</li>
            <li>Shared instructions, model instructions and reply controls are cleared.</li>
            <li>Your chats, Library and downloaded models stay.</li>
            <li>Which Ollama Gates Local uses stays as it is.</li>
          </ul>
          <div className="ca">
            <button type="button" className="btn ghost" data-testid="settings.advanced.reset-cancel" onClick={() => setAsking(false)}>
              Cancel
            </button>
            <button
              type="button"
              className="btn mp-danger"
              data-testid="settings.advanced.reset-confirm"
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
      ["Start or stop dictation", ["Ctrl", "Shift", "Space"]],
      ["Cancel dictation", ["Esc"]],
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
      return <Instructions />;
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
