// Sits between one page and the server on the app's WebSocket, so a spec can make the
// connection slow or lossy at a chosen frame: hold answers and pushes, deliver a request
// late, or let one request be the last thing the server hears from the page.
import type { Page, WebSocketRoute } from "@playwright/test";

export interface Tap {
  /** Requests the page sent, by method. */
  readonly calls: Map<string, number>;
  /** Methods whose answers, and channels whose pushes, wait here until released. */
  readonly hold: Set<string>;
  /** Requests of these methods reach the server this many milliseconds after the page sent them. */
  readonly late: Map<string, number>;
  queued(method: string): number;
  release(method: string): number;
  /** Requests still waiting for their answer. */
  readonly pending: Set<unknown>;
  /**
   * From now on the page's first request of one of `methods` is the last frame the server gets
   * from it: every other frame is dropped, and the connection to the server closes behind that one.
   */
  lastWords(methods: readonly string[]): void;
  /** True once the request lastWords waited for has gone and the connection is closed. */
  cut(): boolean;
}

export async function tap(page: Page): Promise<Tap> {
  const calls = new Map<string, number>();
  const hold = new Set<string>();
  const late = new Map<string, number>();
  const held = new Map<string, (() => void)[]>();
  const pending = new Set<unknown>();
  const methodOf = new Map<unknown, string>();
  let last: ReadonlySet<string> | undefined;
  let cut = false;
  await page.routeWebSocket(/.*/, (ws: WebSocketRoute) => {
    const server = ws.connectToServer();
    ws.onMessage((m) => {
      if (cut) return;
      const req = parse(m);
      const method = req?.type === "request" && typeof req.method === "string" ? req.method : undefined;
      if (last !== undefined) {
        if (method === undefined || !last.has(method)) return;
        cut = true;
        server.send(m);
        server.close();
        return;
      }
      if (method !== undefined) {
        calls.set(method, (calls.get(method) ?? 0) + 1);
        methodOf.set(req?.id, method);
        pending.add(req?.id);
      }
      const wait = method === undefined ? undefined : late.get(method);
      if (wait === undefined) server.send(m);
      // the delay is the slow connection itself, not a wait for the app
      else setTimeout(() => { if (!cut) server.send(m); }, wait);
    });
    server.onMessage((m) => {
      const res = parse(m);
      const method = res?.type === "response" ? (methodOf.get(res.id) ?? "") : res?.type === "push" ? channelOf(res) : "";
      const deliver = () => { pending.delete(res?.id); ws.send(m); };
      if (hold.has(method)) {
        const waiting = held.get(method) ?? [];
        waiting.push(deliver); held.set(method, waiting);
      } else deliver();
    });
    // a page cut off on purpose is not told: it is closed by its spec the next moment
    server.onClose((code, reason) => {
      if (cut) return;
      // a close without a sendable code (the connection just went) is passed on as a plain close
      const sendable = code !== undefined && (code === 1000 || code >= 3000);
      void ws.close(sendable ? { code, ...(reason === undefined ? {} : { reason }) } : {});
    });
  });
  return {
    calls,
    hold,
    late,
    pending,
    queued: method => held.get(method)?.length ?? 0,
    release: method => {
      hold.delete(method);
      const waiting = held.get(method) ?? [];
      held.delete(method);
      waiting.forEach(deliver => deliver());
      return waiting.length;
    },
    lastWords: (methods) => { last = new Set(methods); },
    cut: () => cut,
  };
}

function channelOf(frame: object): string {
  return "channel" in frame && typeof frame.channel === "string" ? frame.channel : "";
}

function parse(m: string | Buffer): { type?: unknown; id?: unknown; method?: unknown } | undefined {
  if (typeof m !== "string") return undefined;
  try {
    return JSON.parse(m) as { type?: unknown; id?: unknown; method?: unknown };
  } catch {
    return undefined;
  }
}
