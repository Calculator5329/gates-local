import { realpath, stat } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

// external: Electron's security checklist warns that a file:// page can read other local files.
export const CLIENT_SCHEME = "gates-local";
export const CLIENT_HOST = "app";
export const CLIENT_ORIGIN = `${CLIENT_SCHEME}://${CLIENT_HOST}`;

export function originOf(url: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.protocol === "file:" || parsed.host === "") return null;
  if (SPECIAL_SCHEMES.has(parsed.protocol)) return `${parsed.protocol}//${parsed.host}`;
  let host: string;
  try {
    host = new URL(`http://${parsed.hostname}/`).hostname;
  } catch {
    return null;
  }
  return `${parsed.protocol}//${host}${parsed.port === "" ? "" : `:${parsed.port}`}`;
}

const SPECIAL_SCHEMES = new Set(["http:", "https:", "ws:", "wss:", "ftp:"]);

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

function isInside(base: string, file: string, pathImpl: typeof path = path): boolean {
  const inside = pathImpl.relative(base, file);
  return inside !== "" && inside.split(pathImpl.sep)[0] !== ".." && !pathImpl.isAbsolute(inside);
}

export type Served = { kind: "file"; path: string } | { kind: "refused" } | { kind: "missing" };

// external: Electron's file fetch follows links with no checks of its own, so containment uses real paths.
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

export async function clientResponse(root: string, requestUrl: string, fetchFile: (fileUrl: string) => Promise<Response>): Promise<Response> {
  const served = await servedFile(root, requestUrl);
  if (served.kind === "refused") return new Response("Not found", { status: 404 });
  if (served.kind === "missing") throw new Error("no client file for this gates-local request");
  return fetchFile(pathToFileURL(served.path).toString());
}
