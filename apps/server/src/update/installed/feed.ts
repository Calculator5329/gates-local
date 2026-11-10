// The one network read an installed copy makes for updates: a bounded GET
// of the release list or its signature (contract: the signed version list
// of a release, docs/releasing.md).
//
// https only, every redirect too, at most FEED_LIMITS.redirects of them. The
// copy adds no query string (a redirect's own query is followed as given:
// GitHub's asset links are signed that way), sends no cookie and keeps none,
// and names itself "Gates-Local" without a version. A body over its limit is dropped
// as soon as it is seen. A test build alone may read a loopback http feed.
import http, { type IncomingMessage } from "node:http";
import https from "node:https";

export const FEED_LIMITS = {
  redirects: 5,
  listBytes: 64 * 1024,
  signatureBytes: 1024,
  /** Connecting, and any silence after: one socket timeout covers both. */
  idleMs: 30_000,
  /** The whole read, every redirect included. */
  totalMs: 60_000,
} as const;

export const USER_AGENT = "Gates-Local";

export type Fetched =
  | { readonly kind: "ok"; readonly bytes: Buffer }
  | { readonly kind: "missing" }
  | { readonly kind: "too-large" }
  | { readonly kind: "failed"; readonly detail: string };

/** One bounded read of url, never more than maxBytes of body. */
export type Get = (url: URL, maxBytes: number, signal: AbortSignal) => Promise<Fetched>;

export interface GetOptions {
  /** Test builds only: also read http from 127.0.0.1, localhost or [::1]. */
  readonly allowLoopbackHttp?: boolean;
  /** Tests shorten it; the default is FEED_LIMITS.idleMs. */
  readonly idleMs?: number;
}

const LOOPBACK = new Set(["127.0.0.1", "localhost", "[::1]"]);

/** Why this address may not be read, or null when it may. */
export function refusedAddress(url: URL, allowLoopbackHttp: boolean): string | null {
  if (url.username !== "" || url.password !== "") return "an address with a user name or password";
  if (url.protocol === "https:") return null;
  if (url.protocol === "http:" && allowLoopbackHttp && LOOPBACK.has(url.hostname)) return null;
  return `a ${url.protocol} address (only https is read)`;
}

type Answer = Fetched | { readonly kind: "redirect"; readonly location: string };
const REDIRECTS = new Set([301, 302, 303, 307, 308]);

function once(url: URL, maxBytes: number, idleMs: number, signal: AbortSignal): Promise<Answer> {
  return new Promise<Answer>((resolve) => {
    const failed = (detail: string) => { clearTimeout(headers); resolve({ kind: "failed", detail }); };
    const silent = () => new Error(`no answer for ${Math.round(idleMs / 1000)} seconds`);
    const read = (res: IncomingMessage) => {
      clearTimeout(headers);
      const status = res.statusCode ?? 0;
      // A body this read will not use is never read: hang up, so a server
      // that keeps streaming it cannot hold the connection open.
      if (REDIRECTS.has(status)) {
        const location = res.headers.location;
        request.destroy();
        resolve(location === undefined ? { kind: "failed", detail: `HTTP ${status} without a location` } : { kind: "redirect", location });
        return;
      }
      if (status === 404) { request.destroy(); resolve({ kind: "missing" }); return; }
      if (status !== 200) { request.destroy(); failed(`HTTP ${status}`); return; }
      const declared = Number(res.headers["content-length"]);
      if (Number.isFinite(declared) && declared > maxBytes) { request.destroy(); resolve({ kind: "too-large" }); return; }
      const chunks: Buffer[] = [];
      let size = 0;
      res.on("data", (chunk: Buffer) => {
        size += chunk.length;
        if (size > maxBytes) { request.destroy(); resolve({ kind: "too-large" }); return; }
        chunks.push(chunk);
      });
      res.on("end", () => resolve({ kind: "ok", bytes: Buffer.concat(chunks) }));
      res.on("error", (error) => failed(error.message));
      res.on("close", () => { if (!res.complete) failed("the connection closed before the whole file arrived"); });
    };
    // agent false: a fresh connection each time, nothing pooled between checks.
    const options = { method: "GET", headers: { "User-Agent": USER_AGENT, Accept: "*/*" }, timeout: idleMs, signal, agent: false } as const;
    const request = url.protocol === "https:" ? https.request(url, options, read) : http.request(url, options, read);
    // Connecting (TCP and TLS) up to the response headers: one idle period
    // from the start. The socket timeout covers any silence after that.
    const headers = setTimeout(() => request.destroy(silent()), idleMs);
    request.on("timeout", () => request.destroy(silent()));
    request.on("error", (error) => {
      const reason: unknown = signal.reason;
      failed(signal.aborted && reason instanceof Error ? reason.message : error.message);
    });
    request.end();
  });
}

/** The real reader: node's http(s), no proxy, no cookie jar, no decompression.
 *  The total time is the caller's signal: checkInstalled gives the list and
 *  its signature one FEED_LIMITS.totalMs deadline between them. */
export function boundedGet(options: GetOptions = {}): Get {
  const idleMs = options.idleMs ?? FEED_LIMITS.idleMs;
  const allowLoopbackHttp = options.allowLoopbackHttp === true;
  return async (start, maxBytes, signal) => {
    let url = start;
    for (let hop = 0; ; hop++) {
      const refused = refusedAddress(url, allowLoopbackHttp);
      if (refused !== null) return { kind: "failed", detail: `refused ${refused}` };
      const answer = await once(url, maxBytes, idleMs, signal);
      if (answer.kind !== "redirect") return answer;
      if (hop >= FEED_LIMITS.redirects) return { kind: "failed", detail: `more than ${FEED_LIMITS.redirects} redirects` };
      try { url = new URL(answer.location, url); }
      catch { return { kind: "failed", detail: "a redirect to something that is not an address" }; }
    }
  };
}
