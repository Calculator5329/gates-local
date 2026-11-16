import http, { type IncomingMessage } from "node:http";
import https from "node:https";

/**
 * `modelsBytes` is for the signed chat model list (models.json); the built-in
 * one is under 4 KiB. `idleMs` covers connecting and any silence after;
 * `totalMs` is the whole read, every redirect included.
 */
export const FEED_LIMITS = {
  redirects: 5,
  listBytes: 64 * 1024,
  signatureBytes: 1024,
  modelsBytes: 64 * 1024,
  idleMs: 30_000,
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

/**
 * What a read does with a 200 body. Any result one of these returns ends the
 * read there and hangs up, so the rest of the body is never received.
 * `declared` gets the Content-Length before a byte is read; `chunk` gets each
 * chunk in order, and while a promise it returned is pending the response is paused.
 */
export interface Body<T> {
  readonly declared?: (length: number) => T | undefined;
  readonly chunk: (bytes: Buffer) => T | undefined | Promise<T | undefined>;
  readonly end: () => T;
}

export type Streamed<T> = T | { readonly kind: "missing" } | { readonly kind: "failed"; readonly detail: string };

/** One read of url whose 200 body goes to body. */
export type Stream = <T>(url: URL, body: Body<T>, signal: AbortSignal) => Promise<Streamed<T>>;

/** `allowLoopbackHttp` is for test builds only: also read http from 127.0.0.1, localhost or [::1]. */
export interface GetOptions {
  readonly allowLoopbackHttp?: boolean;
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

type Answer<T> = Streamed<T> | { readonly kind: "redirect"; readonly location: string };
const REDIRECTS = new Set([301, 302, 303, 307, 308]);
const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

function once<T>(url: URL, body: Body<T>, idleMs: number, signal: AbortSignal): Promise<Answer<T>> {
  return new Promise<Answer<T>>((resolve) => {
    let settled = false;
    const settle = (answer: Answer<T>) => {
      if (settled) return;
      settled = true;
      clearTimeout(headers);
      resolve(answer);
    };
    const failed = (detail: string) => settle({ kind: "failed", detail });
    const hangUp = (answer: Answer<T>) => { request.destroy(); settle(answer); };
    const silent = () => new Error(`no answer for ${Math.round(idleMs / 1000)} seconds`);
    const read = (res: IncomingMessage) => {
      clearTimeout(headers);
      const status = res.statusCode ?? 0;
      if (REDIRECTS.has(status)) {
        const location = res.headers.location;
        hangUp(location === undefined ? { kind: "failed", detail: `HTTP ${status} without a location` } : { kind: "redirect", location });
        return;
      }
      if (status === 404) { hangUp({ kind: "missing" }); return; }
      if (status !== 200) { hangUp({ kind: "failed", detail: `HTTP ${status}` }); return; }
      const declared = Number(res.headers["content-length"]);
      const early = Number.isFinite(declared) ? body.declared?.(declared) : undefined;
      if (early !== undefined) { hangUp(early); return; }
      // why: the chunk after a pending write waits for it, and end waits for the last one.
      let pending: Promise<void> = Promise.resolve();
      res.on("data", (chunk: Buffer) => {
        if (settled) return;
        let taken: T | undefined | Promise<T | undefined>;
        try { taken = body.chunk(chunk); }
        catch (error) { hangUp({ kind: "failed", detail: message(error) }); return; }
        if (!(taken instanceof Promise)) { if (taken !== undefined) hangUp(taken); return; }
        res.pause();
        pending = taken.then(
          (result) => { if (result !== undefined) hangUp(result); else if (!settled) res.resume(); },
          (error: unknown) => hangUp({ kind: "failed", detail: message(error) }),
        );
      });
      res.on("end", () => {
        void pending.then(() => {
          if (settled) return;
          try { settle(body.end()); }
          catch (error) { failed(message(error)); }
        });
      });
      res.on("error", (error) => failed(error.message));
      res.on("close", () => { if (!res.complete) failed("the connection closed before the whole file arrived"); });
    };
    // external: Node pools connections unless agent is false; each check gets a fresh one.
    const options = { method: "GET", headers: { "User-Agent": USER_AGENT, Accept: "*/*" }, timeout: idleMs, signal, agent: false } as const;
    const request = url.protocol === "https:" ? https.request(url, options, read) : http.request(url, options, read);
    const headers = setTimeout(() => request.destroy(silent()), idleMs);
    request.on("timeout", () => request.destroy(silent()));
    request.on("error", (error) => {
      const reason: unknown = signal.aborted ? signal.reason : undefined;
      failed(reason instanceof Error ? reason.message : error.message);
    });
    request.end();
  });
}

/** The real reader: node's http(s), no proxy, no cookie jar, no decompression.
 *  The total time is the caller's signal: checkInstalled gives the list and
 *  its signature one FEED_LIMITS.totalMs deadline between them; an artifact
 *  has none (download.ts bounds its rate instead). */
export function streamGet(options: GetOptions = {}): Stream {
  const idleMs = options.idleMs ?? FEED_LIMITS.idleMs;
  const allowLoopbackHttp = options.allowLoopbackHttp === true;
  return async <T>(start: URL, body: Body<T>, signal: AbortSignal): Promise<Streamed<T>> => {
    let url = start;
    for (let hop = 0; ; hop++) {
      const refused = refusedAddress(url, allowLoopbackHttp);
      if (refused !== null) return { kind: "failed", detail: `refused ${refused}` };
      const answer: Answer<T> = await once(url, body, idleMs, signal);
      if (!isRedirect(answer)) return answer;
      if (hop >= FEED_LIMITS.redirects) return { kind: "failed", detail: `more than ${FEED_LIMITS.redirects} redirects` };
      try { url = new URL(answer.location, url); }
      catch { return { kind: "failed", detail: "a redirect to something that is not an address" }; }
    }
  };
}

function isRedirect<T>(answer: Answer<T>): answer is { readonly kind: "redirect"; readonly location: string } {
  return typeof answer === "object" && answer !== null && "kind" in answer && answer.kind === "redirect" && "location" in answer;
}

function inMemory(maxBytes: number): Body<Fetched> {
  const chunks: Buffer[] = [];
  let size = 0;
  return {
    declared: (length) => (length > maxBytes ? { kind: "too-large" } : undefined),
    chunk: (bytes) => {
      size += bytes.length;
      if (size > maxBytes) return { kind: "too-large" };
      chunks.push(bytes);
      return undefined;
    },
    end: () => ({ kind: "ok", bytes: Buffer.concat(chunks) }),
  };
}

/** The list and signature reader: streamGet into memory. */
export function boundedGet(options: GetOptions = {}): Get {
  const stream = streamGet(options);
  return (url, maxBytes, signal) => stream(url, inMemory(maxBytes), signal);
}
