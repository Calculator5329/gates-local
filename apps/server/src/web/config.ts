// The phone listener's knobs, read once at start. Off unless
// GATES_LOCAL_WEB_LISTEN is set; once it is, every other knob must be right
// or the server refuses to start (fail closed). Messages never repeat the
// user value.
import path from "node:path";
import { isLoopbackHost } from "../ws/server.ts";
import { exactOrigin, validUser } from "./phone.ts";

export interface PhoneConfig {
  readonly host: string;
  readonly port: number;
  readonly origin: string;
  readonly user: string;
  readonly webRoot: string;
}

export type PhoneConfigResult = { readonly ok: true; readonly value: PhoneConfig | null } | { readonly ok: false; readonly message: string };

export function phoneConfig(env: NodeJS.ProcessEnv): PhoneConfigResult {
  const listen = env["GATES_LOCAL_WEB_LISTEN"] ?? "";
  if (listen === "") return { ok: true, value: null };
  const m = /^(\[::1\]|\d{1,3}(?:\.\d{1,3}){3}):(\d{1,5})$/.exec(listen);
  const host = m?.[1]?.replace(/^\[(.*)\]$/, "$1");
  const port = Number(m?.[2]);
  if (host === undefined || !isLoopbackHost(host)) {
    return { ok: false, message: `GATES_LOCAL_WEB_LISTEN must be a loopback address and port (127.0.0.1:<port> or [::1]:<port>), got "${listen}"` };
  }
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    return { ok: false, message: `GATES_LOCAL_WEB_LISTEN needs a port 1-65535, got "${listen}"` };
  }
  const origin = env["GATES_LOCAL_WEB_ORIGIN"] ?? "";
  if (exactOrigin(origin) === null) {
    return { ok: false, message: `GATES_LOCAL_WEB_ORIGIN must be the exact public origin, like https://hub.example.ts.net:8456 (no path or trailing slash), got "${origin}"` };
  }
  const user = env["GATES_LOCAL_WEB_USER"] ?? "";
  if (!validUser(user)) {
    return { ok: false, message: "GATES_LOCAL_WEB_USER must be the one Tailscale-User-Login allowed (non-empty, no spaces or commas)" };
  }
  const webRoot = env["GATES_LOCAL_WEB_ROOT"] ?? "";
  if (webRoot === "") return { ok: false, message: "GATES_LOCAL_WEB_ROOT must name the built web client (apps/web/dist) when GATES_LOCAL_WEB_LISTEN is set" };
  return { ok: true, value: { host, port, origin, user, webRoot: path.resolve(webRoot) } };
}
