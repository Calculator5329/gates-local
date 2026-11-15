// Layout adapts T3 Code (MIT, Copyright (c) 2026 T3 Tools Inc.); full notice in LICENSES/T3-Code-MIT.txt.
// Runtime words (shell.md F01, F18, F22, F42): the sidebar footer row, the
// composer placeholder and the banner docked above the composer, one entry
// per RuntimeStatus state plus "offline" for a dropped server connection.
import { type ReactNode, useState } from "react";
import { figuresMoved, stalledNow, wakeAtStall } from "./install-stall.ts";
import type { CatalogEntry, RuntimeStatus } from "@gates-local/contracts";
import { NBSP, describeModel, etaText, gb } from "./format.ts";
import { rowOf } from "./fit-table.ts";
import { Icon } from "./icons.tsx";
import { canChat, chatBlockedReason, modelNameKey } from "./pick.ts";
import { firstPull, pull, recheckRuntime } from "./session.ts";
import { NA, type State, useStore } from "./store.ts";

export type Rt = "ready" | "installing" | "starting" | "missing" | "wrong" | "stopped" | "error" | "offline";

/**
 * The app's first read since it opened has not landed. Nothing is known yet,
 * so nothing claims a problem: no banner, no runtime row, no greyed controls,
 * and what depends on the data holds a placeholder (docs/design.md). A
 * connection that drops later is "down", never this, and says Reconnecting.
 * Two seconds without a first read end it, and the connection words show.
 */
export function booting(s: Pick<State, "conn" | "runtime" | "hydrationSettled"> & Partial<Pick<State, "bootWaited">>): boolean {
  return s.runtime === undefined && !s.hydrationSettled && !s.bootWaited && (s.conn.kind === "connecting" || s.conn.kind === "open");
}

/**
 * The runtime has not answered once since the app opened, past the boot
 * bound too. Nothing about Ollama is known, so the words say only that the
 * app is connecting; the Ollama sentences wait for a real "starting" or
 * "stopped".
 */
export function unread(s: Pick<State, "runtime">): boolean {
  return s.runtime === undefined;
}

/**
 * "starting" before any Ollama was found (the server's first status, owner "none"): a search, said
 * as one. Only the app's own copy, which it found and launched, is "Starting Ollama".
 */
export const searching = (s: Pick<State, "runtime">): boolean => s.runtime?.state === "starting" && s.runtime.owner !== "app";

/** The composer's one word while nothing is read. */
export const CONNECTING = "Connecting…";

/** settings, when given, lets the words say Gates Local runs its own copy. */
type RtSource = Pick<State, "conn" | "runtime"> & Partial<Pick<State, "settings">>;

export function rtOf(s: RtSource): Rt {
  if (s.conn.kind !== "open") return "offline";
  const st = s.runtime?.state;
  if (st === undefined) return "starting";
  return st === "wrong-service" ? "wrong" : st;
}

/**
 * When Gates Local runs its own Ollama (Settings' runtimeMode "app"), the one
 * sentence that says so and names any port it routed around; the ports come
 * from the server's runtime status (busyPorts, never parsed from the detail). "" otherwise, and in
 * the system-Ollama "wrong" state, which has its own words.
 */
export function ownCopyNote(s: RtSource): string {
  const rt = rtOf(s);
  if (rt === "wrong" || rt === "ready" || rt === "offline") return "";
  const port = portOf(s.runtime?.baseUrl);
  const busy = (s.runtime?.busyPorts ?? []).filter((p) => p !== port);
  if (busy.length > 0) {
    return `Something other than Ollama answers on ${busy.length === 1 ? "port" : "ports"} ${busy.join(" and ")}, so Gates Local uses its own Ollama on port ${port}.`;
  }
  return s.settings !== NA && s.settings?.runtimeMode === "app" ? `Gates Local uses its own Ollama on port ${port}.` : "";
}

export function portOf(baseUrl: string | undefined): string {
  if (baseUrl === undefined) return "11434";
  try {
    return new URL(baseUrl).port || "11434";
  } catch {
    return "11434";
  }
}

export const PLACEHOLDER: Record<Rt, string> = {
  ready: "Ask anything…",
  // a message typed during setup says when it goes once, in its queue row (chat row 31)
  installing: "Ask anything…",
  starting: "Chat starts when Ollama is running…",
  missing: "Install Ollama to start chatting",
  wrong: "Chat starts when Ollama answers on its port",
  stopped: "Chat starts when Ollama is running…",
  error: "Chat starts when Ollama is running…",
  offline: "Chat starts when Gates Local reconnects…",
};

type InstallSize = { receivedBytes: number; totalBytes: number; bytesPerSecond?: number | undefined; diskBytes?: number | undefined };

/** The step while the app's own Ollama installs, as the first window, the banner and the sidebar tip say it. */
export const installStep = (i: InstallSize | undefined): string => (i !== undefined && i.receivedBytes >= i.totalBytes ? "Unpacking Ollama" : "Downloading Ollama");

/** One figure with its words ("2.1 GB on disk") held together: a narrow line breaks only at the " · " between figures. */
const whole = (part: string): string => part.replaceAll(" ", NBSP);

/** Numbers only, after the step: how far the download is and the time left, then the disk the copy takes. */
export function installWords(i: InstallSize | undefined): string | undefined {
  if (i === undefined) return undefined;
  const disk = i.diskBytes === undefined ? [] : [`${gb(i.diskBytes)} on disk`];
  if (i.receivedBytes >= i.totalBytes) return [`${gb(i.totalBytes)} downloaded`, ...disk].map(whole).join(" · ");
  const p = { name: "ollama", state: "downloading" as const, completedBytes: i.receivedBytes, totalBytes: i.totalBytes, ...(i.bytesPerSecond === undefined ? {} : { bytesPerSecond: i.bytesPerSecond }) };
  // etaText's own " · " is the break between its figures; each figure inside it stays whole
  return [...etaText(p, { speed: false }).split(" · "), ...disk].map(whole).join(" · ");
}

export { INSTALL_STALL_MS, figuresMoved, installStalled, wakeAtStall } from "./install-stall.ts";

/** The step's words once the download has stalled, in the first window, the banner, the footer gear and Settings. */
export const STALLED = "Download stalled";

/**
 * The stall as a screen sees it: true once the figures have held for the stall time, and the
 * Retry that ends it (the server starts a stalled download again; the new attempt gets the whole
 * stall time). `words` are the figures without the time left, which a stalled speed does not give.
 * The stall's moment re-renders through the store (wakeAtStall), as it does the footer gear.
 */
export function useInstallStall(i: InstallSize | undefined): { stalled: boolean; words: string | undefined; retry: () => void } {
  const [, retried] = useState(0);
  const stalled = stalledNow(i);
  const retry = () => {
    figuresMoved(i?.receivedBytes ?? 0, Date.now(), true);
    retried((n) => n + 1);
    wakeAtStall();
    void recheckRuntime();
  };
  const { bytesPerSecond: _, ...still } = i ?? { receivedBytes: 0, totalBytes: 0 };
  return { stalled, words: installWords(stalled ? still : i), retry };
}

/** The engine install's title, the same in the first window and the banner. */
export const INSTALL_TITLE = "Getting the chat engine ready";

/** What failed, as the runtime status says it. */
export type Failure = RuntimeStatus["failure"];

/**
 * A runtime "error" by what failed (RuntimeStatus.failure): a download that stopped, one that
 * came down but is not the pinned file, an unpack that failed, or a start. `title` heads the banner
 * and the first window, `stat` is the gear's and Settings › Runtime's word. A status without a
 * cause is a start, as it was before causes.
 */
export function failWords(failure: Failure): { title: string; stat: string } {
  switch (failure) {
    case "download":
      return { title: "The Ollama download didn't finish", stat: "Download didn't finish" };
    case "checksum":
      return { title: "The Ollama download didn't match its checksum", stat: "Checksum didn't match" };
    case "disk":
      return { title: "Not enough disk space for Ollama", stat: "Not enough disk space" };
    case "install":
      return { title: "Ollama didn't install", stat: "Didn't install" };
    case "start":
    case undefined:
      return { title: "Ollama didn't start", stat: "Didn't start" };
  }
}

/**
 * The server's detail under a title that has already named the download: its sentence without
 * the subject, so "The Ollama download" is said once; a checksum's first sentence (the title's,
 * with the two hashes) is left out, and a full disk's "The disk is full." (the title named the
 * disk), leaving the figures. Any other detail is shown as it came.
 */
export function underTitle(detail: string | undefined, failure: Failure): string | undefined {
  if (failure === "download") return detail?.replace(/^The Ollama download stopped at /, "Stopped at ");
  if (failure === "checksum") return detail?.replace(/^The Ollama download [^.]*\.\s*/, "") || undefined;
  if (failure === "disk") return detail?.replace(/^The disk is full\.\s*/, "") || undefined;
  return detail;
}

/** The sentence under a failure's title when the server sent none. */
const FAIL_FALLBACK: Record<NonNullable<Failure>, string> = {
  download: "Check the network, then retry.",
  checksum: "Nothing was installed. Retry once.",
  disk: "Free some space on this drive, then retry.",
  install: "Gates Local couldn't unpack Ollama.",
  start: "Gates Local couldn't start Ollama.",
};

/** The footer row: dot class, the words (with a bold lead) and the tooltip. */
export function rtInfo(s: RtSource): { dot: string; text: ReactNode; tip: string } {
  const rt = rtOf(s);
  const port = portOf(s.runtime?.baseUrl);
  const own = ownCopyNote(s);
  switch (rt) {
    case "ready":
      return s.runtime?.owner === "app"
        ? { dot: "ok", text: <><b>Ollama</b> · Gates Local</>, tip: "<b>Ready.</b> Gates Local's own copy. It starts with the app and stops when the app quits." }
        : { dot: "ok", text: <><b>Ollama</b> · system</>, tip: "<b>Ready.</b> System install, started outside Gates Local. Gates Local uses it and never stops it." };
    case "installing":
      // the numbers are the banner's and Settings › Runtime's (the gear opens it): the gear's tip names the step only
      return stalledNow(s.runtime?.install)
        ? { dot: "warn", text: <b>{STALLED}</b>, tip: "Open Settings › Runtime to retry." }
        : { dot: "run", text: <b>{installStep(s.runtime?.install)}</b>, tip: "" };
    case "starting":
      return searching(s)
        ? { dot: "run", text: <b>Looking for Ollama</b>, tip: `Checking port ${port}.` }
        : { dot: "run", text: <b>Starting Ollama</b>, tip: `Waiting for the server on port ${port}.` };
    case "missing":
      return { dot: "warn", text: <b>Ollama not installed</b>, tip: own === "" ? "No Ollama install found. Gates Local can install its own copy." : `No Ollama install found. ${own}` };
    case "wrong":
      return { dot: "err", text: <><b>Port {port}</b> · busy</>, tip: `Something other than Ollama answers on port ${port}.` };
    case "stopped":
      return { dot: "warn", text: <b>Ollama stopped</b>, tip: own === "" ? `Nothing answers on port ${port}. Start Ollama, then retry.` : `${own} It starts when Gates Local opens.` };
    case "error":
      // the words say what failed; the tip says where to act, not the words again
      return { dot: "err", text: <b>{failWords(s.runtime?.failure).title}</b>, tip: "Open Settings › Runtime for details and Retry." };
    case "offline":
      return { dot: "run", text: <b>Reconnecting</b>, tip: "The Gates Local server stopped answering. Trying again." };
  }
}

function Shell({ icon, role, title, children }: { icon: ReactNode; role: "status" | "alert"; title: string; children: ReactNode }) {
  return (
    <div className="banner" role={role}>
      {icon}
      <div style={{ flex: 1, minWidth: 0 }}>
        <div className="bt">{title}</div>
        {children}
      </div>
    </div>
  );
}

const RetryButton = ({ primary }: { primary?: boolean }) => (
  <button type="button" className={primary ? "btn primary" : "btn outline"} data-testid="chat.banner.retry" onClick={() => void recheckRuntime()}>
    Retry
  </button>
);

/** The model to recommend when none is installed: the first pick of the computer's tier that runs here. */
export function recommendedEntry(s: State): CatalogEntry | undefined {
  if (s.catalog === NA || s.catalog === undefined) return undefined;
  const picks = s.catalog.filter((c) => c.recommended).toSorted((a, b) => (a.rank ?? 0) - (b.rank ?? 0));
  return picks.find((c) => rowOf(s, c.name)?.verdict !== "refuse") ?? picks[0];
}

/**
 * The first model to offer, read from the state and never from a stored flag: Ollama answers, its
 * list is in and holds no chat model, and a download here would give one. Undefined otherwise (an
 * Ollama too old to say which models chat, a build that cannot download).
 */
export function firstModelOffer(s: State): CatalogEntry | undefined {
  if (s.runtime?.state !== "ready" || s.models === undefined || s.models.some(canChat)) return undefined;
  if (chatBlockedReason(s.models, undefined) !== undefined || s.unavailable["models.pull"] === true) return undefined;
  return recommendedEntry(s);
}

/** A message in the open chat that waits for a chat model (a picture does not). */
const waitsHere = (s: State): boolean => s.threadId !== null && s.queued.some((q) => q.threadId === s.threadId && q.draw === undefined);

/**
 * Ollama is ready with no chat model: the first window's offer, in its words and sizes, wherever
 * the person is (first run left early, the new chat, a message waiting), until a model exists.
 * Once its download runs the model button's bar and a waiting message's row show it, so the
 * banner says nothing more.
 */
function FirstModel() {
  const entry = useStore(firstModelOffer);
  const downloading = useStore((s) => firstPull(s) !== undefined);
  const catalog = useStore((s) => (s.catalog === NA ? undefined : s.catalog));
  const waits = useStore(waitsHere);
  // the last try at this model ended in an error: said once, as the Models chip says it
  const failed = useStore((s) => entry !== undefined && Object.values(s.pulls).some((p) => p.state === "error" && modelNameKey(p.name.trim()) === modelNameKey(entry.name)));
  if (entry === undefined || downloading) return null;
  const name = describeModel(entry.name, catalog).name;
  return (
    <Shell icon={<Icon id="download" />} role="status" title={waits ? "Your message waits for a model" : "Download your first model"}>
      <div className="bm">
        {failed ? `${name} did not finish downloading.` : name}
        <span className="fig"> · {gb(entry.downloadBytes)} download</span>
      </div>
      <div className="ba">
        <button type="button" className="btn primary" data-testid="chat.banner.first-model" onClick={() => void pull(entry.name)}>
          Download and start
        </button>
      </div>
    </Shell>
  );
}

/** The engine install: the step and its numbers as the first window says them; a stalled download says so and shows Retry. */
function Installing({ install }: { install: InstallSize | undefined }) {
  const { stalled, words, retry } = useInstallStall(install);
  return (
    <Shell icon={stalled ? <Icon id="alert" cls="warn" /> : <Icon id="download" />} role="status" title={INSTALL_TITLE}>
      {/* words in full, figures in the app's font */}
      <div className="bm">
        {stalled ? STALLED : installStep(install)}
        {words === undefined ? null : <span className="fig"> · {words}</span>}
      </div>
      {stalled ? (
        <div className="ba">
          <button type="button" className="btn primary" data-testid="chat.banner.retry" onClick={retry}>
            Retry
          </button>
        </div>
      ) : null}
    </Shell>
  );
}

/** The banner for the current runtime state; nothing when chat is ready and a chat model is in. */
export function Banner() {
  const rt = useStore(rtOf);
  const baseUrl = useStore((s) => s.runtime?.baseUrl);
  const detail = useStore((s) => s.runtime?.detail);
  const own = useStore(ownCopyNote);
  const install = useStore((s) => s.runtime?.install);
  const failure = useStore((s) => s.runtime?.failure);
  // first run tells the runtime story itself; the banner under it stays quiet
  const firstRun = useStore((s) => s.view === "firstrun");
  const boot = useStore(booting);
  // nothing read yet: the composer says Connecting, once
  const none = useStore(unread);
  const looking = useStore(searching);
  const port = portOf(baseUrl);
  if (firstRun || boot || none) return null;
  switch (rt) {
    case "ready":
      return <FirstModel />;
    case "installing":
      return <Installing install={install} />;
    case "wrong":
      return (
        <Shell icon={<Icon id="alert" cls="err" />} role="alert" title={`Port ${port} answers, but not as Ollama`}>
          <div className="bm">
            Another service holds <span className="mono">localhost:{port}</span> and doesn't speak the Ollama API. Gates Local won't stop it.
          </div>
          <div className="ba">
            <RetryButton />
          </div>
        </Shell>
      );
    case "starting":
      return looking ? (
        <Shell icon={<Icon id="spin" cls="spin warn" />} role="status" title="Looking for Ollama">
          <div className="bm">
            Checking <span className="mono">localhost:{port}</span>.
          </div>
        </Shell>
      ) : (
        <Shell icon={<Icon id="spin" cls="spin warn" />} role="status" title="Starting Ollama">
          <div className="bm">
            Waiting for <span className="mono">localhost:{port}</span>. The first start after boot takes a few seconds.
          </div>
        </Shell>
      );
    case "missing":
      return (
        <Shell icon={<Icon id="alert" cls="warn" />} role="alert" title="Ollama isn't installed">
          <div className="bm">
            {own === "" ? "" : `${own} `}Install Ollama from ollama.com, then retry.
          </div>
          <div className="ba">
            <RetryButton primary />
          </div>
        </Shell>
      );
    case "stopped":
      return (
        <Shell icon={<Icon id="alert" cls="warn" />} role="alert" title="Ollama isn't running">
          {own === "" ? (
            <div className="bm">
              Nothing answers on <span className="mono">localhost:{port}</span>. Start Ollama, then retry.
            </div>
          ) : (
            <div className="bm">{own} It starts when Gates Local opens; retry to check again.</div>
          )}
          <div className="ba">
            <RetryButton primary />
          </div>
        </Shell>
      );
    case "error":
      return (
        <Shell icon={<Icon id="alert" cls="err" />} role="alert" title={failWords(failure).title}>
          <div className="bm">{underTitle(detail, failure) ?? FAIL_FALLBACK[failure ?? "start"]}</div>
          <div className="ba">
            <RetryButton primary />
          </div>
        </Shell>
      );
    case "offline":
      return (
        <Shell icon={<Icon id="spin" cls="spin warn" />} role="status" title="Reconnecting to Gates Local">
          <div className="bm">The app's server stopped answering. Your threads are saved; chat picks up when it's back.</div>
        </Shell>
      );
  }
}
