// The built web client is served on its own scheme, gates-local://app, not
// file://. Electron's security checklist warns that a file:// page can read
// other local files, and the renderer shows model output. The scheme also
// gives the WebSocket upgrade a fixed Origin the server can allow exactly
// (a file:// page sends "file://", which every local file shares).
// Pure functions only, so the mapping is tested without Electron.

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
  return `${parsed.protocol}//${parsed.host}`;
}

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
  if (url.protocol !== `${CLIENT_SCHEME}:` || url.host !== CLIENT_HOST) return null;
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
  const inside = pathImpl.relative(base, file);
  if (inside === "" || inside.split(pathImpl.sep)[0] === ".." || pathImpl.isAbsolute(inside)) return null;
  return file;
}
