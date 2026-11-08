// The built web client is served on its own scheme, gates-local://app, not
// file://. Electron's security checklist warns that a file:// page can read
// other local files, and the renderer shows model output. The scheme also
// gives the WebSocket upgrade a fixed Origin the server can allow exactly
// (a file:// page sends "file://", which every local file shares).
// Pure functions only, so the mapping is tested without Electron.

import { realpath, stat } from "node:fs/promises";
import path from "node:path";

export const CLIENT_SCHEME = "gates-local";
export const CLIENT_HOST = "app";
export const CLIENT_ORIGIN = `${CLIENT_SCHEME}://${CLIENT_HOST}`;

/**
 * Scheme and host of a URL. WHATWG URL gives "null" as the origin of a
 * non-special scheme such as gates-local:, so two different custom schemes
 * would compare equal; this compares what Chromium sends instead.
 * file: and unparsable URLs give null: they are never an allowed origin.
 */
export function originOf(url: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.protocol === "file:" || parsed.host === "") return null;
  if (SPECIAL_SCHEMES.has(parsed.protocol)) return `${parsed.protocol}//${parsed.host}`;
  // WHATWG keeps a non-special host opaque (gates-local://APP stays "APP"),
  // but gates-local is registered as a standard scheme, so Chromium
  // canonicalises its host like http's: lowercase, percent-decoded. Reparse
  // the host as http to match what the renderer sends; keep the port as given.
  let host: string;
  try {
    host = new URL(`http://${parsed.hostname}/`).hostname;
  } catch {
    return null;
  }
  return `${parsed.protocol}//${host}${parsed.port === "" ? "" : `:${parsed.port}`}`;
}

const SPECIAL_SCHEMES = new Set(["http:", "https:", "ws:", "wss:", "ftp:"]);

/**
 * The URL to open in the system browser for a link the client follows, or
 * null. Only http and https pages with a host and no credentials go out:
 * a reply is model output, and file:, javascript:, custom OS schemes and
 * user:pass@ links must never reach the shell.
 */
export function externalUrl(target: string): string | null {
  let url: URL;
  try {
    url = new URL(target);
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  if (url.hostname === "" || url.username !== "" || url.password !== "") return null;
  return url.href;
}

/** True when target is a page of the client at clientUrl (a file client must match its path). */
export function sameClient(clientUrl: string, target: string): boolean {
  let client: URL;
  let next: URL;
  try {
    client = new URL(clientUrl);
    next = new URL(target);
  } catch {
    return false;
  }
  if (client.protocol === "file:") return next.protocol === "file:" && next.pathname === client.pathname;
  const origin = originOf(clientUrl);
  return origin !== null && origin === originOf(target);
}

/**
 * The file under root that a gates-local://app request names, or null when
 * the request is for another host, does not decode, or would leave root.
 * pathImpl is a parameter so the Windows rules are tested on Linux.
 */
export function clientFile(root: string, requestUrl: string, pathImpl: typeof path = path): string | null {
  let url: URL;
  try {
    url = new URL(requestUrl);
  } catch {
    return null;
  }
  if (originOf(requestUrl) !== CLIENT_ORIGIN) return null;
  let relative: string;
  try {
    relative = decodeURIComponent(url.pathname);
  } catch {
    return null;
  }
  if (relative.includes("\0")) return null;
  if (relative === "/" || relative === "") relative = "/index.html";
  const base = pathImpl.resolve(root);
  const file = pathImpl.resolve(base, `.${relative}`);
  return isInside(base, file, pathImpl) ? file : null;
}

/** True when file is strictly under base (not base itself). */
function isInside(base: string, file: string, pathImpl: typeof path = path): boolean {
  const inside = pathImpl.relative(base, file);
  return inside !== "" && inside.split(pathImpl.sep)[0] !== ".." && !pathImpl.isAbsolute(inside);
}

export type Served = { kind: "file"; path: string } | { kind: "refused" } | { kind: "missing" };

/**
 * The real file a gates-local://app request may be served from. clientFile's
 * check is lexical, and Electron's file fetch follows links without its own
 * checks, so a symlink or Windows junction under the root could expose a file
 * outside it. This resolves the root and the file and checks containment on
 * the resolved paths. "missing" (no such file, or a directory) makes the
 * handler fail the load, as before, so the window shows the retry page.
 */
export async function servedFile(root: string, requestUrl: string): Promise<Served> {
  const file = clientFile(root, requestUrl);
  if (file === null) return { kind: "refused" };
  let realRoot: string;
  let real: string;
  try {
    realRoot = await realpath(root);
    real = await realpath(file);
  } catch {
    return { kind: "missing" };
  }
  if (!isInside(realRoot, real)) return { kind: "refused" };
  try {
    return (await stat(real)).isFile() ? { kind: "file", path: real } : { kind: "missing" };
  } catch {
    return { kind: "missing" };
  }
}
