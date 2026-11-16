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

export function quitOnAllClosed(mode: LaunchMode): boolean {
  return !mode.background;
}

export type SecondInstanceAction = "none" | "create" | "restore" | "focus";

export interface SecondLaunch {
  readonly hasWindow: boolean;
  readonly minimized: boolean;
  readonly background: boolean;
}

export function secondInstanceAction(launch: SecondLaunch): SecondInstanceAction {
  if (launch.background) return "none";
  if (!launch.hasWindow) return "create";
  return launch.minimized ? "restore" : "focus";
}

export interface ServerEnvInput {
  readonly env: NodeJS.ProcessEnv;
  readonly clientOrigin: string | null;
  readonly webRoot: string;
  readonly installedVersion?: string | null;
}

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
