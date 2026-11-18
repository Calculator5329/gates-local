import { type ReactNode, useState } from "react";
import type { RuntimeStatus } from "@gates-local/contracts";
import { useNow } from "../lib/ui/kit/now.ts";
import { NBSP, etaText, gb } from "../lib/words/format.ts";
import { recheckRuntime } from "../lib/session/index.ts";
import { NA, type State } from "../lib/store/store.ts";
import { stalledNow } from "./install-stall.ts";

export type Rt = "ready" | "installing" | "starting" | "missing" | "wrong" | "stopped" | "error" | "offline";

export function booting(s: Pick<State, "conn" | "runtime" | "hydrationSettled"> & Partial<Pick<State, "bootWaited">>): boolean {
  return s.runtime === undefined && !s.hydrationSettled && !s.bootWaited && (s.conn.kind === "connecting" || s.conn.kind === "open");
}

export function unread(s: Pick<State, "runtime">): boolean {
  return s.runtime === undefined;
}

export const searching = (s: Pick<State, "runtime">): boolean => s.runtime?.state === "starting" && s.runtime.owner !== "app";

export const CONNECTING = "Connecting…";

// why: the server sends no start time for a look, so it counts from when this place first showed it
export function Looked() {
  const [from] = useState(Date.now);
  const now = useNow(1000);
  return <span className="fig">{` · ${Math.max(0, Math.floor((now - from) / 1000))} s`}</span>;
}

type RtSource = Pick<State, "conn" | "runtime"> & Partial<Pick<State, "settings">>;

export function rtOf(s: RtSource): Rt {
  if (s.conn.kind !== "open") return "offline";
  const st = s.runtime?.state;
  if (st === undefined) return "starting";
  return st === "wrong-service" ? "wrong" : st;
}

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
  installing: "Ask anything…",
  starting: "Chat starts when Ollama is running…",
  missing: "Install Ollama to start chatting",
  wrong: "Chat starts when Ollama answers…",
  stopped: "Chat starts when Ollama is running…",
  error: "Chat starts when Ollama is running…",
  offline: "Chat starts when Gates Local reconnects…",
};

export type InstallSize = { receivedBytes: number; totalBytes: number; bytesPerSecond?: number | undefined; diskBytes?: number | undefined; stalled?: true | undefined; quietMs?: number | undefined };

export const installStep = (i: InstallSize | undefined): string => (i !== undefined && i.receivedBytes >= i.totalBytes ? "Unpacking Ollama" : "Downloading Ollama");

const whole = (part: string): string => part.replaceAll(" ", NBSP);

export function installWords(i: InstallSize | undefined): string | undefined {
  if (i === undefined) return undefined;
  const disk = i.diskBytes === undefined ? [] : [`${gb(i.diskBytes)} on disk`];
  if (i.receivedBytes >= i.totalBytes) return [`${gb(i.totalBytes)} downloaded`, ...disk].map(whole).join(" · ");
  const p = { name: "ollama", state: "downloading" as const, completedBytes: i.receivedBytes, totalBytes: i.totalBytes, ...(i.bytesPerSecond === undefined ? {} : { bytesPerSecond: i.bytesPerSecond }) };
  return [...etaText(p, { speed: false }).split(" · "), ...disk].map(whole).join(" · ");
}

export { stalledNow } from "./install-stall.ts";

export const STALLED = "Download stalled";

export function useInstallStall(i: InstallSize | undefined): { stalled: boolean; words: string | undefined; retry: () => void } {
  const stalled = stalledNow(i);
  const { bytesPerSecond: _, ...still } = i ?? { receivedBytes: 0, totalBytes: 0 };
  // why: the one reason the server can know, at its own bound, so it stays true while it waits
  const quiet = stalled && i?.quietMs !== undefined ? `no data for over ${Math.max(1, Math.round(i.quietMs / 1000))}${NBSP}s` : undefined;
  const figures = installWords(stalled ? still : i);
  return { stalled, words: quiet === undefined ? figures : figures === undefined ? quiet : `${figures} · ${quiet}`, retry: retryInstall };
}

const retryInstall = () => { void recheckRuntime(); };

export const INSTALL_TITLE = "Getting the chat engine ready";

export type Failure = RuntimeStatus["failure"];

export function failWords(failure: Failure): { title: string; stat: string } {
  switch (failure) {
    case "download":
      return { title: "The Ollama download didn't finish", stat: "Download didn't finish" };
    case "checksum":
      return { title: "The download couldn't be verified", stat: "Couldn't verify download" };
    case "disk":
      return { title: "Not enough disk space for Ollama", stat: "Not enough disk space" };
    case "install":
      return { title: "Ollama didn't install", stat: "Didn't install" };
    case "start":
    case undefined:
      return { title: "Ollama didn't start", stat: "Didn't start" };
  }
}

// why: matches the server's two "site didn't answer" details (runtime/install.ts)
const unreached = (detail: string | undefined): boolean => detail !== undefined && /^Could not reach |failed: HTTP \d+ from /.test(detail);

// why: the server says "failed: HTTP <status> from"; a 404 or 410 means the file is gone
const gone = (detail: string | undefined): boolean => detail !== undefined && /failed: HTTP (404|410) from /.test(detail);

export const SITE_DOWN = "The download site didn't respond. Try again in a moment.";
const DOWNLOAD_GONE = "This download is no longer available. Retry after the app updates, or install Ollama from ollama.com.";

// why: the server's "The Ollama download stopped at <figures> (<reason>)" (runtime/install.ts)
const STOPPED_AT = /^The Ollama download stopped at (.+?) \([^)]*\)/;

function downloadLine(detail: string | undefined): string {
  if (gone(detail)) return DOWNLOAD_GONE;
  if (unreached(detail)) return SITE_DOWN;
  const at = detail === undefined ? undefined : STOPPED_AT.exec(detail)?.[1];
  return at === undefined ? FAIL_FALLBACK.download : `Stopped at ${at}. ${FAIL_FALLBACK.download}`;
}

export function underTitle(detail: string | undefined, failure: Failure): string | undefined {
  if (failure === "download") return downloadLine(detail);
  if (failure === "checksum") return FAIL_FALLBACK.checksum;
  if (failure === "disk") return detail?.replace(/^The disk is full\.\s*/, "") || undefined;
  return detail;
}

// why: a checksum, an HTTP status, an address or a socket's reason helps no one deciding: data-why
export const failWhy = (detail: string | undefined, failure: Failure): string | undefined =>
  failure === "checksum" || failure === "download" ? detail : undefined;

// why: the state also covers a port that did not answer in time; this is the banner's name for it
export const PORT_TAKEN = "Another program is where Ollama should be";
export const PORT_TAKEN_SHORT = "Another program in its place";
export const PORT_TAKEN_BODY = "Gates Local won't stop it. It can run its own Ollama instead.";

// why: the switch keeps its own confirm in Settings, so a place offering it opens Settings
export const canUseOwn = (s: Pick<State, "settings" | "runtime" | "unavailable">): boolean =>
  s.settings !== NA && s.settings !== undefined && s.settings.runtimeMode !== "app" && s.runtime?.noAppCopy !== true && s.unavailable["settings.update"] !== true;

export const FAIL_FALLBACK: Record<NonNullable<Failure>, string> = {
  download: "Check the network, then retry.",
  checksum: "Download it again.",
  disk: "Free some space on this drive, then retry.",
  // why: the title already says what failed, so the line under it says only what to do
  install: "Retry. If it fails again, install Ollama from ollama.com.",
  start: "Retry. If it still won't start, install Ollama from ollama.com.",
};

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
      return { dot: "err", text: <b>{PORT_TAKEN_SHORT}</b>, tip: `Something other than Ollama answers on port ${port}.` };
    case "stopped":
      return { dot: "warn", text: <b>Ollama stopped</b>, tip: own === "" ? `Nothing answers on port ${port}. Start Ollama, then retry.` : `${own} It starts when Gates Local opens.` };
    case "error":
      return { dot: "err", text: <b>{failWords(s.runtime?.failure).title}</b>, tip: "Open Settings › Runtime for details and Retry." };
    case "offline":
      return { dot: "run", text: <b>Reconnecting</b>, tip: "The Gates Local server stopped answering. Trying again." };
  }
}
