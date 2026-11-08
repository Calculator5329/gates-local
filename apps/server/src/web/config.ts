// The phone listener's knobs, read once at start. Off unless
// GATES_LOCAL_WEB_LISTEN is set; once it is, every other knob must be right
// or the server refuses to start (fail closed). LISTEN takes only
// unix:<absolute path>: a TCP port, even on loopback, is open to every local
// user, and this listener trusts Serve's headers instead of a token. Messages
// never repeat the user value.
import path from "node:path";
import { exactOrigin, validUser } from "./phone.ts";
import { parsePeers } from "./source.ts";

export interface PhoneConfig {
  /** The owner-only Unix socket Tailscale Serve proxies to. */
  readonly socketPath: string;
  readonly origin: string;
  readonly user: string;
  readonly webRoot: string;
  /** GATES_LOCAL_WEB_PEERS, normalised: when set, the only source addresses admitted. */
  readonly peers?: readonly string[];
}

export type PhoneConfigResult = { readonly ok: true; readonly value: PhoneConfig | null } | { readonly ok: false; readonly message: string };

export function phoneConfig(env: NodeJS.ProcessEnv): PhoneConfigResult {
  const listen = env["GATES_LOCAL_WEB_LISTEN"] ?? "";
  if (listen === "") return { ok: true, value: null };
  if (!listen.startsWith("unix:")) {
    const tcp = /(^|:)\d{1,5}$/.test(listen);
    return {
      ok: false,
      message: tcp
        ? `GATES_LOCAL_WEB_LISTEN must be unix:<absolute path>; TCP is refused (any local user could reach it), got "${listen}"`
        : `GATES_LOCAL_WEB_LISTEN must be unix:<absolute path>, got "${listen}"`,
    };
  }
  const socketPath = listen.slice("unix:".length);
  if (!path.isAbsolute(socketPath)) {
    return { ok: false, message: `GATES_LOCAL_WEB_LISTEN needs an absolute socket path after unix:, got "${listen}"` };
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
  const peersText = env["GATES_LOCAL_WEB_PEERS"] ?? "";
  const peers = peersText === "" ? undefined : parsePeers(peersText);
  if (peers === null) {
    return { ok: false, message: `GATES_LOCAL_WEB_PEERS must be comma-separated IP addresses (the phones' Tailscale addresses, no ports), got "${peersText}"` };
  }
  const value = { socketPath: path.normalize(socketPath), origin, user, webRoot: path.resolve(webRoot) };
  return { ok: true, value: peers === undefined ? value : { ...value, peers } };
}
