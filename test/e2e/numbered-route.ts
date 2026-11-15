// A routed page socket that keeps ordered data numbered. The server numbers every answer and push
// of an ordered kind, and the window refuses one without a number; a spec that answers a method or
// pushes a value itself (to reach a state no real server would be in on cue) sends it through
// here, and it goes out as the newest value of its thing.
//
// The numbers the page sees are this route's own, one counter per scope: a value from the server
// that is newer than any it sent before takes the next one, a value it sent before keeps its, an
// older one gets 0 (never newer than what the page has), and a value a spec makes up takes the
// next one. So a spec's value and the server's interleave in the order they reach the page.
import { methodSync, pushSync, scopesOf, type MethodName, type SyncDomain, type SyncMetadata, type SyncRow } from "@gates-local/contracts";
import type { WebSocketRoute } from "@playwright/test";

type Frame = { type?: string; id?: string; ok?: boolean; channel?: string; method?: string; result?: unknown; sync?: SyncMetadata };

export interface NumberedRoute {
  /** The page side: sends stamp or renumber; messages from the page are read for their method. */
  readonly page: WebSocketRoute;
  /** The server side, forwarding to the page through the numbering until a spec handles it itself. */
  readonly server: WebSocketRoute;
}

/** Number `socket`'s traffic; use the returned `page` wherever the spec used `socket`. */
export function numberedRoute(socket: WebSocketRoute): NumberedRoute {
  let epoch: string | undefined;
  let ordered: readonly SyncDomain[] = [];
  const methods = new Map<string, MethodName>();
  const counters = new Map<string, number>();
  const seen = new Map<string, Map<number, number>>();
  const newest = new Map<string, number>();

  const next = (scope: string) => { const n = (counters.get(scope) ?? 0) + 1; counters.set(scope, n); return n; };
  /** The page's number for the server's `rev` of `scope`. */
  const renumber = (scope: string, rev: number): number => {
    const known = seen.get(scope) ?? new Map<number, number>();
    seen.set(scope, known);
    const before = known.get(rev);
    if (before !== undefined) return before;
    if (rev <= (newest.get(scope) ?? -1)) return 0;
    newest.set(scope, rev);
    const n = next(scope);
    known.set(rev, n);
    return n;
  };
  const rowOf = (frame: Frame): SyncRow | undefined => {
    if (frame.type === "push" && frame.channel !== undefined) return pushSync(frame.channel as never);
    if (frame.type === "response" && frame.id !== undefined) { const method = methods.get(frame.id); return method === undefined ? undefined : methodSync(method); }
    return undefined;
  };
  const stamp = (raw: string | Buffer): string | Buffer => {
    if (typeof raw !== "string") return raw;
    let frame: Frame;
    try { frame = JSON.parse(raw) as Frame; } catch { return raw; }
    if (frame.type === "response" && frame.id !== undefined && methods.get(frame.id) === "sync.negotiate" && frame.ok === true) {
      const result = frame.result as { epoch: string; ordered: readonly SyncDomain[] };
      epoch = result.epoch; ordered = result.ordered;
      return raw;
    }
    if (epoch === undefined || (frame.type === "response" && frame.ok !== true)) return raw;
    if (frame.sync !== undefined) {
      // The server's numbers (a frame passed on, or a spec's edit of one) become this route's.
      const changes = frame.sync.changes.map(change => {
        const rev = renumber(change.scope, change.rev);
        return change.kind === "patch" ? { ...change, baseRev: Math.max(0, rev - 1), rev } : { ...change, rev };
      });
      return JSON.stringify({ ...frame, sync: { epoch, changes } });
    }
    const row = rowOf(frame);
    if (row === undefined || !ordered.includes(row.domain)) return raw;
    // A spec's own value: the newest of its thing (and of each thing it carries beside it, as a list's runtime).
    return JSON.stringify({ ...frame, sync: { epoch, changes: scopesOf(row).map(scope => ({ scope, kind: "snapshot", rev: next(scope) })) } });
  };

  const upstream = socket.connectToServer();
  const toPage = (raw: string | Buffer) => socket.send(stamp(raw));
  upstream.onMessage(toPage);
  const server: WebSocketRoute = Object.assign(Object.create(upstream) as WebSocketRoute, {
    send: (raw: string | Buffer) => upstream.send(raw),
    onMessage: (handler: (raw: string | Buffer) => unknown) => upstream.onMessage(handler),
  });
  const page: WebSocketRoute = Object.assign(Object.create(socket) as WebSocketRoute, {
    send: toPage,
    onMessage: (handler: (raw: string | Buffer) => unknown) => socket.onMessage(raw => {
      if (typeof raw === "string") {
        try { const m = JSON.parse(raw) as Frame; if (m.id !== undefined && m.method !== undefined) methods.set(m.id, m.method as MethodName); } catch { /* not a frame */ }
      }
      return handler(raw);
    }),
    connectToServer: () => server,
  });
  // Until a spec reads the page's messages itself, they go to the server, read on the way.
  page.onMessage(raw => upstream.send(raw));
  return { page, server };
}
