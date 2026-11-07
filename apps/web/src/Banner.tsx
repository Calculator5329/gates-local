// Runtime words (shell.md F01, F18, F22, F42): the sidebar footer row, the
// composer placeholder and the banner docked above the composer, one entry
// per RuntimeStatus state plus "offline" for a dropped server connection.
import type { ReactNode } from "react";
import { Icon } from "./icons.tsx";
import { recheckRuntime } from "./session.ts";
import { type State, useStore } from "./store.ts";

export type Rt = "ready" | "installing" | "starting" | "missing" | "wrong" | "stopped" | "error" | "offline";

type RtSource = Pick<State, "conn" | "runtime">;

export function rtOf(s: RtSource): Rt {
  if (s.conn.kind !== "open") return "offline";
  const st = s.runtime?.state;
  if (st === undefined) return "starting";
  return st === "wrong-service" ? "wrong" : st;
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
  installing: "Type now; it sends when setup finishes",
  starting: "Chat starts when Ollama is running…",
  missing: "Install Ollama to start chatting",
  wrong: "Chat starts when Ollama answers on its port",
  stopped: "Chat starts when Ollama is running…",
  error: "Chat starts when Ollama is running…",
  offline: "Chat starts when Gates Local reconnects…",
};

/** The footer row: dot class, the words (with a bold lead) and the tooltip. */
export function rtInfo(s: RtSource): { dot: string; text: ReactNode; tip: string } {
  const rt = rtOf(s);
  const port = portOf(s.runtime?.baseUrl);
  const v = s.runtime?.version;
  switch (rt) {
    case "ready":
      return s.runtime?.owner === "app"
        ? { dot: "ok", text: <><b>Ollama{v ? ` ${v}` : ""}</b> · Gates Local</>, tip: "<b>Ready.</b> Gates Local's own copy. It starts with the app and stops when the app quits." }
        : { dot: "ok", text: <><b>Ollama{v ? ` ${v}` : ""}</b> · system</>, tip: "<b>Ready.</b> System install, started outside Gates Local. Gates Local uses it and never stops it." };
    case "installing":
      return { dot: "run", text: <b>Installing Ollama</b>, tip: "Downloading Ollama into the Gates Local app folder. Your first model downloads next." };
    case "starting":
      return { dot: "run", text: <b>Starting Ollama</b>, tip: `Waiting for the server on port ${port}.` };
    case "missing":
      return { dot: "warn", text: <b>Ollama not installed</b>, tip: "No Ollama install found. Gates Local can install its own copy." };
    case "wrong":
      return { dot: "err", text: <><b>Port {port}</b> · busy</>, tip: `Something other than Ollama answers on port ${port}.` };
    case "stopped":
      return { dot: "warn", text: <b>Ollama stopped</b>, tip: `Nothing answers on port ${port}. Start Ollama, then retry.` };
    case "error":
      return { dot: "err", text: <b>Ollama didn't start</b>, tip: "Ollama failed to start. Open Settings › Runtime for details." };
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
  <button type="button" className={primary ? "btn primary" : "btn outline"} onClick={() => void recheckRuntime()}>
    Retry
  </button>
);

/** The banner for the current runtime state; nothing when chat is ready. */
export function Banner() {
  const rt = useStore(rtOf);
  const baseUrl = useStore((s) => s.runtime?.baseUrl);
  const detail = useStore((s) => s.runtime?.detail);
  const port = portOf(baseUrl);
  switch (rt) {
    case "ready":
      return null;
    case "installing":
      return (
        <Shell icon={<Icon id="download" />} role="status" title="Setting up Ollama">
          <div className="bm">
            No Ollama was found, so Gates Local is installing{" "}
            <span className="tipd" tabIndex={0} data-tip='Into <span class="mono">~/.local/share/gates-local/ollama</span>. Gates Local starts and stops only this copy.'>
              its own copy
            </span>
            , then your first model.
          </div>
        </Shell>
      );
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
      return (
        <Shell icon={<Icon id="spin" cls="spin warn" />} role="status" title="Starting Ollama">
          <div className="bm">
            Waiting for <span className="mono">localhost:{port}</span>. The first start after boot takes a few seconds.
          </div>
        </Shell>
      );
    case "missing":
      return (
        <Shell icon={<Icon id="alert" cls="warn" />} role="alert" title="Ollama isn't installed">
          <div className="bm">Install Ollama system-wide, then retry. Installing Gates Local's own copy is not available in this build.</div>
          <div className="ba">
            <RetryButton primary />
          </div>
        </Shell>
      );
    case "stopped":
      return (
        <Shell icon={<Icon id="alert" cls="warn" />} role="alert" title="Ollama isn't running">
          <div className="bm">
            Nothing answers on <span className="mono">localhost:{port}</span>. Start Ollama, then retry.
          </div>
          <div className="ba">
            <RetryButton primary />
          </div>
        </Shell>
      );
    case "error":
      return (
        <Shell icon={<Icon id="alert" cls="err" />} role="alert" title="Ollama didn't start">
          <div className="bm">{detail ?? "Gates Local couldn't start Ollama."}</div>
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
