// One connection's reconnect loop, RPCs and draft-persistence lifetime.
import { type Client, type MethodName, type Params, type ResultOf, WireError, createClient } from "@gates-local/contracts";
import { NA, setState } from "../store.ts";

interface ConnectionEffects {
  readonly serverUrl: () => Promise<string | null>;
  readonly webServerUrl: () => string | null;
  readonly desktopBridge: () => Window["gatesLocal"];
  readonly hydrate: (client: Client) => Promise<void>;
  readonly beforeDisconnect: () => void;
  readonly afterDisconnect: () => void;
}

export const isNA = (e: unknown): boolean => e instanceof WireError && e.code === "not-implemented";
export const codeOf = (e: unknown): string => (e instanceof WireError ? e.code : "internal");

/**
 * What an action hands back to the control that ran it: null when it worked,
 * else one calm sentence saying what failed and what to do, shown beside it.
 */
export type ActionResult = string | null;

type Acted<M extends MethodName> = { readonly ok: true; readonly value: ResultOf<M> } | { readonly ok: false; readonly message: string };

/** "Couldn't <what> because <reason>; <todo>." in plain words, never the raw stack. */
export function failure(what: string, e: unknown, todo = "try again"): string {
  const code = codeOf(e);
  if (code === "closed") return `Couldn't ${what} because Gates Local isn't connected; try again once it reconnects.`;
  if (code === "timeout") return `Couldn't ${what} because Gates Local didn't answer in time; ${todo}.`;
  if (code === "not-implemented") return `Couldn't ${what} because this build can't do that yet.`;
  return `Couldn't ${what} because ${reasonOf(e instanceof Error ? e.message : String(e))}; ${todo}.`;
}

function reasonOf(message: string): string {
  if (/\bENOENT\b|no such file/i.test(message)) return "nothing is at that path";
  if (/\bEACCES\b|\bEPERM\b|permission denied/i.test(message)) return "Gates Local isn't allowed to read it";
  const kind = /must be a (folder|file)/i.exec(message)?.[1];
  if (kind) return `that path is not a ${kind}`;
  if (/own data directory/i.test(message)) return "it holds Gates Local's own data";
  const short = message.replace(/^\w*Error:\s*/, "").replace(/[.\s]+$/, "");
  return `Gates Local refused it (${short.length > 120 ? `${short.slice(0, 117)}…` : short})`;
}

/** Domain cleanup stays with the session; its two hooks surround clearing the current client. */
export function createConnection({ serverUrl, webServerUrl, desktopBridge, hydrate, beforeDisconnect, afterDisconnect }: ConnectionEffects) {
  /** Resolves on the bridge's next ready state, or after ms when there is no bridge. */
  function nextChance(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const bridge = desktopBridge();
      const timer = setTimeout(done, ms);
      const off = bridge?.onState((s) => {
        if (s.status === "ready") done();
      });
      function done() {
        clearTimeout(timer);
        off?.();
        resolve();
      }
    });
  }

  let client: Client | null = null;
  let stopped = false;

  /** Start the connection loop. Called once at boot; the returned function ends it (the session tests use it). */
  function connect(): () => void {
    stopped = false;
    if (!desktopBridge() && webServerUrl() === null) setState({ conn: { kind: "no-server" } });
    else void loop();
    return () => {
      stopped = true;
      stopDrafts?.();
      stopDrafts = undefined;
      client?.close();
    };
  }

  let stopDrafts: (() => void) | undefined;

  async function loop(): Promise<void> {
    let delay = 250;
    for (;;) {
      if (stopped) return;
      const url = await serverUrl().catch(() => null);
      if (url === null) {
        if (!desktopBridge()) return setState({ conn: { kind: "no-server" } });
        await nextChance(60_000);
        continue;
      }
      const parsed = new URL(url);
      // Image URLs follow the socket's scheme: wss gives https.
      setState({ serverOrigin: `${parsed.protocol === "wss:" ? "https:" : "http:"}//${parsed.host}`, fileToken: parsed.searchParams.get("token") });
      if (!stopDrafts && typeof indexedDB !== "undefined") {
        try { stopDrafts = await (await import("../draft-persistence.ts")).watchDraft(desktopBridge() ? "desktop" : parsed.host); }
        catch { setState({ notice: "Image drafts cannot be saved on this device. Keep this window open until you send them." }); }
        if (stopped) { stopDrafts?.(); stopDrafts = undefined; return; }
      }
      const ws = new WebSocket(url);
      const c = createClient(ws, { onProtocolError: (e) => console.warn(`[gates-local] ${e.code}`) });
      const opened = await new Promise<boolean>((resolve) => {
        ws.addEventListener("open", () => resolve(true));
        ws.addEventListener("close", () => resolve(false));
      });
      if (opened && stopped) {
        c.close();
        return;
      }
      if (opened) {
        client = c;
        delay = 250;
        setState({ conn: { kind: "open" } });
        await hydrate(c).catch(() => undefined);
        await c.closed;
        beforeDisconnect();
        client = null;
        afterDisconnect();
      }
      setState((s) => ({ conn: s.conn.kind === "down" ? s.conn : { kind: "down", since: Date.now() } }));
      await nextChance(delay);
      delay = Math.min(delay * 2, 4000);
    }
  }

  /** Call a server method; rejects with WireError("closed") while disconnected. */
  function call<M extends MethodName>(method: M, params: Params<M>): Promise<ResultOf<M>> {
    if (client === null) return Promise.reject(new WireError("closed", `not connected; ${method} not sent`));
    return client.call(method, params);
  }

  /** A v2 read: its result, NA when the server lacks it, undefined on any other failure. */
  async function probe<M extends MethodName>(method: M, params: Params<M>): Promise<ResultOf<M> | typeof NA | undefined> {
    try {
      return await call(method, params);
    } catch (e) {
      return isNA(e) ? NA : undefined;
    }
  }

  /** Run an action method; NA marks it unavailable for the rest of the session. `what` completes "Couldn't …". */
  async function act<M extends MethodName>(method: M, params: Params<M>, what: string, todo = "try again"): Promise<Acted<M>> {
    try {
      return { ok: true, value: await call(method, params) };
    } catch (e) {
      if (isNA(e)) setState((s) => ({ unavailable: { ...s.unavailable, [method]: true } }));
      return { ok: false, message: failure(what, e, todo) };
    }
  }

  /** Library-only RPCs use the same connection as manual additions. */
  async function libraryRequest<M extends "sources.imports" | "sources.downloadSample" | "sources.clone" | "sources.cancelImport">(method: M, params: import("@gates-local/contracts").Params<M>): Promise<import("@gates-local/contracts").ResultOf<M>> {
    if (!client) throw new Error("Gates Local isn't connected. Try again once it reconnects.");
    return client.call(method, params);
  }

  return { connect, call, probe, act, libraryRequest, get stopped() { return stopped; } };
}
