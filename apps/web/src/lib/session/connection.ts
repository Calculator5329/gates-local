import { type CallOptions, type Client, type MethodName, type Params, type ReplyCall, type ReplyOutcome, type ResultOf, WireError, createClient } from "@gates-local/contracts";
import { NA, setState } from "../store/store.ts";
import { pinFramePolicy } from "../../pages/frame-policy.ts";
import { withTimeout } from "../ui/kit/async.ts";
import { claimWindow } from "./window-id.ts";

interface ConnectionEffects {
  readonly applyServerEvent: typeof setState;
  readonly serverUrl: () => Promise<string | null>;
  readonly webServerUrl: () => string | null;
  readonly desktopBridge: () => Window["gatesLocal"];
  readonly hydrate: (client: Client) => Promise<void>;
  readonly afterDisconnect: () => void;
}

let thisWindow: Promise<string> | undefined;
function windowId(): Promise<string> {
  let storage: Storage | undefined;
  try { storage = sessionStorage; } catch {}
  return thisWindow ??= claimWindow(storage, typeof navigator === "undefined" ? undefined : navigator.locks);
}

export const isNA = (e: unknown): boolean => e instanceof WireError && e.code === "not-implemented";
export const codeOf = (e: unknown): string => (e instanceof WireError ? e.code : "internal");

export type ActionResult = string | null;

type Acted<M extends MethodName> = { readonly ok: true; readonly value: ResultOf<M> } | { readonly ok: false; readonly message: string };
export type ActionCall = <M extends MethodName>(method: M, params: Params<M>, what: string, todo?: string, options?: CallOptions<M>) => Promise<Acted<M>>;

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

export function createConnection({ applyServerEvent, serverUrl, webServerUrl, desktopBridge, hydrate, afterDisconnect }: ConnectionEffects) {
  // why: ms is the longest a retry waits for the desktop app to say its server is ready
  function nextChance(ms: number): Promise<void> {
    let off: (() => void) | undefined;
    const ready = new Promise<void>((resolve) => {
      off = desktopBridge()?.onState((s) => {
        if (s.status === "ready") resolve();
      });
    });
    return withTimeout(ready, ms, () => undefined).finally(() => off?.());
  }

  let client: Client | null = null;
  let stopped = false;

  function connect(): () => void {
    stopped = false;
    let stop: (() => void) | undefined;
    // why: the two seconds the window shows placeholders before it says it is connecting
    void withTimeout(new Promise<void>((resolve) => { stop = resolve; }), 2000, () => applyServerEvent({ bootWaited: true }));
    if (!desktopBridge() && webServerUrl() === null) applyServerEvent({ conn: { kind: "no-server" } });
    else void loop();
    return () => {
      stop?.();
      stopped = true;
      stopDrafts?.();
      stopDrafts = undefined;
      client?.close();
    };
  }

  let stopDrafts: (() => void) | undefined;

  async function loop(): Promise<void> {
    let delay = 250;
    let nextImmediateAt = 0;
    for (;;) {
      if (stopped) return;
      const url = await serverUrl().catch(() => null);
      if (url === null) {
        if (!desktopBridge()) return applyServerEvent({ conn: { kind: "no-server" } });
        await nextChance(60_000);
        continue;
      }
      const parsed = new URL(url);
      const serverOrigin = `${parsed.protocol === "wss:" ? "https:" : "http:"}//${parsed.host}`;
      // why: in the desktop app Electron's main process guards frames; a tab has nothing else
      if (!desktopBridge() && typeof document !== "undefined") pinFramePolicy(serverOrigin);
      applyServerEvent({ serverOrigin, fileToken: parsed.searchParams.get("token") });
      if (!stopDrafts && typeof indexedDB !== "undefined") {
        try { stopDrafts = await (await import("../../composer/draft-persistence.ts")).watchDraft(desktopBridge() ? "desktop" : parsed.host); }
        catch { setState({ notice: "Image drafts cannot be saved on this device. Keep this window open until you send them." }); }
        if (stopped) { stopDrafts?.(); stopDrafts = undefined; return; }
      }
      parsed.searchParams.set("window", await windowId());
      const ws = new WebSocket(parsed.href);
      const c = createClient(ws, { onProtocolError: (e) => console.warn(`[gates-local] ${e.code}`) });
      const opened = await new Promise<boolean>((resolve) => {
        ws.addEventListener("open", () => resolve(true));
        ws.addEventListener("close", () => resolve(false));
      });
      let hydrated = false;
      if (opened && stopped) {
        c.close();
        return;
      }
      if (opened) {
        client = c;
        applyServerEvent({ conn: { kind: "open" }, hydrationSettled: false });
        await hydrate(c).then(() => { delay = 250; hydrated = ws.readyState === 1; }, () => undefined).finally(() => {
          if (!stopped && client === c && ws.readyState === 1 && c.sync !== undefined) applyServerEvent({ hydrationSettled: true });
        });
        await c.closed;
        client = null;
        afterDisconnect();
      }
      applyServerEvent((s) => ({ conn: s.conn.kind === "down" ? s.conn : { kind: "down", since: Date.now() } }));
      if (hydrated && Date.now() >= nextImmediateAt) {
        nextImmediateAt = Date.now() + 1000;
        await nextChance(16);
        delay = Math.min(delay * 2, 4000);
        continue;
      }
      await nextChance(delay);
      delay = Math.min(delay * 2, 4000);
    }
  }

  function call<M extends MethodName>(method: M, params: Params<M>, options?: CallOptions<M>): Promise<ResultOf<M>> {
    if (client === null) return Promise.reject(new WireError("closed", `not connected; ${method} not sent`));
    return client.call(method, params, options);
  }

  function reply<M extends ReplyCall>(method: M, params: Params<M>): Promise<ReplyOutcome> {
    if (client === null) return Promise.resolve({ answer: "not-reached", why: "closed" });
    return client.reply(method, params);
  }

  async function probe<M extends MethodName>(method: M, params: Params<M>, options?: CallOptions<M>): Promise<ResultOf<M> | typeof NA | undefined> {
    try {
      return await call(method, params, options);
    } catch (e) {
      return isNA(e) ? NA : undefined;
    }
  }

  async function act<M extends MethodName>(method: M, params: Params<M>, what: string, todo = "try again", options?: CallOptions<M>): Promise<Acted<M>> {
    try {
      return { ok: true, value: await call(method, params, options) };
    } catch (e) {
      if (isNA(e)) applyServerEvent((s) => ({ unavailable: { ...s.unavailable, [method]: true } }));
      return { ok: false, message: failure(what, e, todo) };
    }
  }

  async function libraryRequest<M extends "sources.imports" | "sources.downloadSample" | "sources.clone" | "sources.cancelImport">(method: M, params: import("@gates-local/contracts").Params<M>): Promise<import("@gates-local/contracts").ResultOf<M>> {
    if (!client) throw new Error("Gates Local isn't connected. Try again once it reconnects.");
    return client.call(method, params);
  }

  return { connect, call, reply, probe, act, libraryRequest, get stopped() { return stopped; }, get sync() { return client?.sync; } };
}
