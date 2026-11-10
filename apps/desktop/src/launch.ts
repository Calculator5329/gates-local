// Launch decisions for Electron main, pure so they are tested without
// Electron: whether a window opens at start, whether closing the last window
// quits, what a second launch does, and the server child's environment.
//
// Background mode (`--background` or GATES_LOCAL_BACKGROUND=1) runs the
// supervisor and server with no window, so the phone listener stays up with
// the desktop closed. There is still one server per data dir: launching the
// app again reaches this instance through the single-instance lock and opens
// the window here.

export const BACKGROUND_FLAG = "--background";
export const BACKGROUND_ENV = "GATES_LOCAL_BACKGROUND";

export interface LaunchMode {
  readonly background: boolean;
}

export function launchMode(argv: readonly string[], env: NodeJS.ProcessEnv): LaunchMode {
  return { background: argv.includes(BACKGROUND_FLAG) || env[BACKGROUND_ENV] === "1" };
}

export function windowAtStart(mode: LaunchMode): boolean {
  return !mode.background;
}

/** Background mode keeps running with no window; quit and SIGTERM still stop the server. */
export function quitOnAllClosed(mode: LaunchMode): boolean {
  return !mode.background;
}

/** What the running instance does when the app is launched again. */
export type SecondInstanceAction = "none" | "create" | "restore" | "focus";

export interface SecondLaunch {
  /** The running instance has a window that is not destroyed. */
  readonly hasWindow: boolean;
  readonly minimized: boolean;
  /** The second launch asked for background mode itself (it carries no window wish). */
  readonly background: boolean;
}

export function secondInstanceAction(launch: SecondLaunch): SecondInstanceAction {
  if (launch.background) return "none";
  if (!launch.hasWindow) return "create";
  return launch.minimized ? "restore" : "focus";
}

export interface ServerEnvInput {
  readonly env: NodeJS.ProcessEnv;
  /** The window client's origin, allowed on the token listener; null for a file: client. */
  readonly clientOrigin: string | null;
  /** The built web client the window serves; the phone listener serves the same files. */
  readonly webRoot: string;
  /** app.getVersion() when the app is packaged, else null. */
  readonly installedVersion?: string | null;
}

/**
 * The server child's environment. The phone knobs (GATES_LOCAL_WEB_LISTEN,
 * _ORIGIN, _USER, _PEERS) pass through as set; with LISTEN set, GATES_LOCAL_WEB_ROOT
 * is the dist dir the window serves, so the phone gets the same client.
 * A packaged app passes its version as GATES_LOCAL_INSTALLED_VERSION, so the
 * server checks the release list instead of building the clone updater; any
 * other launch never passes one on, even from its own environment.
 */
export function serverEnv({ env, clientOrigin, webRoot, installedVersion = null }: ServerEnvInput): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = { ...env };
  out["GATES_LOCAL_DESKTOP"] = "1";
  if (installedVersion === null) delete out["GATES_LOCAL_INSTALLED_VERSION"];
  else out["GATES_LOCAL_INSTALLED_VERSION"] = installedVersion;
  if (clientOrigin !== null) {
    const extra = (env["GATES_LOCAL_ALLOWED_ORIGINS"] ?? "").split(",").map((o) => o.trim()).filter((o) => o !== "");
    out["GATES_LOCAL_ALLOWED_ORIGINS"] = [...extra, clientOrigin].join(",");
  }
  if ((env["GATES_LOCAL_WEB_LISTEN"] ?? "") !== "") out["GATES_LOCAL_WEB_ROOT"] = webRoot;
  return out;
}
