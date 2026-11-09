// Framework-free client over any WebSocket-like object (the browser
// WebSocket and the ws package both fit). Requests are encoded against the
// method table before they leave; results and pushes are decoded on arrival.
import {
  type Channel,
  type MethodName,
  type Params,
  type Payload,
  type ResultOf,
  WireError,
  decodePayload,
  decodeResult,
  decodeServerMessage,
  encodeRequest,
} from "./protocol.ts";
import { ORDERED_DOMAINS, settingsRevision, settingsSnapshotMethod, type SyncDomain, type SyncMetadata, type SyncNegotiation } from "./sync.ts";

const CONNECTING = 0;
const OPEN = 1;

/** The part of the WebSocket interface the client uses. */
export interface SocketLike {
  readonly readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  addEventListener(type: "open" | "close" | "error" | "message", listener: (event: { data?: unknown }) => void): void;
  removeEventListener(type: "open" | "close" | "error" | "message", listener: (event: { data?: unknown }) => void): void;
}

export interface ClientOptions {
  /** Default per-call timeout. 30 s. */
  readonly timeoutMs?: number;
  /** Frames the client could not use (bad envelope, unknown id, bad payload). Defaults to console.warn. */
  readonly onProtocolError?: (error: WireError) => void;
}

export interface CallOptions<M extends MethodName = MethodName> {
  readonly timeoutMs?: number;
  /** Metadata before a successful call settles. Hook failures are reported separately. */
  readonly onMetadata?: (sync: SyncMetadata | undefined) => void;
  /** Accepted wire value before promise completion; stale state must not block acknowledgement. */
  readonly onResult?: (value: ResultOf<M>, sync: SyncMetadata | undefined) => void;
}

export type ClientSync =
  | { readonly mode: "legacy"; readonly epoch?: string }
  | { readonly mode: "ordered"; readonly epoch: string; readonly domains: readonly SyncDomain[] };

export interface Client {
  call<M extends MethodName>(method: M, params: Params<M>, options?: CallOptions<M>): Promise<ResultOf<M>>;
  subscribe<C extends Channel>(channel: C, handler: (payload: Payload<C>, sync?: SyncMetadata) => void): () => void;
  /** Once per socket; only an explicit unsupported-method refusal permits fallback. */
  negotiate(): Promise<ClientSync>;
  readonly sync: ClientSync | undefined;
  /** Resolves when the socket has closed; every pending call is rejected with code "closed" by then. */
  readonly closed: Promise<void>;
  close(): void;
}

interface Pending {
  readonly method: MethodName;
  readonly resolve: (value: never) => void;
  readonly reject: (error: WireError) => void;
  readonly timer: ReturnType<typeof setTimeout>;
  readonly onMetadata?: CallOptions["onMetadata"];
  readonly onResult?: (value: never, sync: SyncMetadata | undefined) => void;
  readonly offered?: readonly SyncDomain[];
}

function frameText(data: unknown): unknown {
  if (typeof data === "string") return data;
  // ws hands Buffers to raw listeners; the browser may hand ArrayBuffers. Text is what the protocol speaks.
  if (data instanceof ArrayBuffer) return new TextDecoder().decode(data);
  if (ArrayBuffer.isView(data)) return new TextDecoder().decode(data as Uint8Array);
  return data;
}

export function createClient(socket: SocketLike, options: ClientOptions = {}): Client {
  const defaultTimeout = options.timeoutMs ?? 30_000;
  const report = (error: WireError) => {
    try {
      if (options.onProtocolError) options.onProtocolError(error);
      else console.warn(`[contracts] ${error.code}: ${error.message}`);
    } catch { /* Diagnostics must not escape socket dispatch. */ }
  };
  const pending = new Map<string, Pending>();
  const outbox: Array<readonly [frame: string, id: string]> = [];
  const subscribers = new Map<Channel, Set<(payload: never, sync?: SyncMetadata) => void>>();
  let sync: ClientSync | undefined;
  let negotiation: Promise<ClientSync> | undefined;
  let nextId = 1;
  let isClosed = socket.readyState > OPEN;
  let markClosed!: () => void;
  const closed = new Promise<void>((resolve) => {
    markClosed = resolve;
  });

  const onOpen = () => {
    for (const [frame, id] of outbox.splice(0)) transmit(frame, id);
  };

  const protocolError = (error: WireError) => {
    try { report(error); } finally { if (sync?.mode === "ordered") client.close(); }
  };
  const metadataError = (metadata: SyncMetadata | undefined, settings: boolean): WireError | undefined => {
    if (sync?.mode !== "ordered") return;
    if ((metadata !== undefined && metadata.epoch !== sync.epoch) ||
      (settings && sync.domains.includes("settings") && settingsRevision(metadata, sync.epoch) === undefined)) {
      return new WireError("bad-message", "missing or invalid settings synchronization metadata; reconnect required");
    }
  };

  const onMessage = (event: { data?: unknown }) => {
    const decoded = decodeServerMessage(frameText(event.data));
    if (!decoded.ok) return protocolError(decoded.error);
    const msg = decoded.value;
    if (msg.type === "push") {
      const p = decodePayload(msg.channel, msg.payload);
      if (!p.ok) return protocolError(p.error);
      const invalid = metadataError(msg.sync, msg.channel === "settings.changed");
      if (invalid) return protocolError(invalid);
      for (const handler of subscribers.get(p.value.channel) ?? []) {
        try {
          handler(p.value.payload as never, msg.sync);
        } catch (e) {
          report(new WireError("internal", `subscriber for ${p.value.channel} threw: ${(e as Error).message}`));
        }
      }
      return;
    }
    const call = pending.get(msg.id);
    if (call === undefined) return report(new WireError("bad-message", `response for unknown id "${msg.id}"`));
    pending.delete(msg.id);
    clearTimeout(call.timer);
    const invalid = metadataError(msg.sync, msg.ok && settingsSnapshotMethod(call.method));
    if (invalid) { call.reject(invalid); return protocolError(invalid); }
    if (!msg.ok) return call.reject(new WireError(msg.error.code, msg.error.message, msg.error.blocking));
    const r = decodeResult(call.method, msg.result);
    if (!r.ok) return call.reject(r.error);
    if (call.method === "sync.negotiate") {
      // The method-specific codec above checked this value. Accept negotiation
      // synchronously, before a following frame from the same socket is handled.
      const negotiated = r.value as SyncNegotiation;
      if (negotiated.ordered.some(domain => !call.offered?.includes(domain))) {
        call.reject(new WireError("bad-result", "server enabled an unrequested ordered domain"));
        client.close(); return;
      }
      sync = negotiated.ordered.length === 0 ? { mode: "legacy", epoch: negotiated.epoch } : { mode: "ordered", epoch: negotiated.epoch, domains: negotiated.ordered };
    }
    try {
      call.onResult?.(r.value as never, msg.sync);
      call.onMetadata?.(msg.sync);
    } catch (e) {
      report(new WireError("internal", `metadata callback threw: ${e instanceof Error ? e.message : String(e)}`));
    } finally {
      call.resolve(r.value as never);
    }
  };

  let listening = true;
  const shutdown = () => {
    isClosed = true;
    sync = undefined;
    outbox.length = 0;
    for (const [id, call] of pending) {
      clearTimeout(call.timer);
      call.reject(new WireError("closed", `socket closed before ${call.method} (${id}) answered`));
    }
    pending.clear();
    if (listening) {
      socket.removeEventListener("open", onOpen);
      socket.removeEventListener("message", onMessage);
      socket.removeEventListener("close", shutdown);
      listening = false;
    }
    markClosed();
  };

  socket.addEventListener("open", onOpen);
  socket.addEventListener("message", onMessage);
  socket.addEventListener("close", shutdown);
  if (isClosed) shutdown();

  const transmit = (frame: string, id: string) => {
    try {
      socket.send(frame);
    } catch (e) {
      const call = pending.get(id);
      if (call === undefined) return;
      pending.delete(id);
      clearTimeout(call.timer);
      call.reject(new WireError("closed", `send failed: ${(e as Error).message}`));
    }
  };

  const client: Client = {
    call(method, params, callOptions) {
      return new Promise((resolve, reject) => {
        if (isClosed) return reject(new WireError("closed", `socket is closed; ${method} not sent`));
        const id = String(nextId++);
        const frame = encodeRequest(id, method, params);
        if (!frame.ok) return reject(frame.error);
        const timeoutMs = callOptions?.timeoutMs ?? defaultTimeout;
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new WireError("timeout", `${method} (${id}) got no response in ${timeoutMs} ms`));
        }, timeoutMs);
        pending.set(id, { method, resolve: resolve as (value: never) => void, reject, timer, onMetadata: callOptions?.onMetadata,
          onResult: callOptions?.onResult as Pending["onResult"],
          ...(method === "sync.negotiate" ? { offered: (params as Params<"sync.negotiate">).ordered } : {}),
        });
        if (socket.readyState === CONNECTING) outbox.push([frame.value, id]);
        else transmit(frame.value, id);
      });
    },
    subscribe(channel, handler) {
      let set = subscribers.get(channel);
      if (set === undefined) subscribers.set(channel, (set = new Set()));
      set.add(handler as (payload: never, sync?: SyncMetadata) => void);
      return () => {
        set.delete(handler as (payload: never, sync?: SyncMetadata) => void);
      };
    },
    negotiate() {
      return negotiation ??= client.call("sync.negotiate", { ordered: ORDERED_DOMAINS }).then((): ClientSync => {
        if (isClosed || sync === undefined) throw new WireError("closed", "socket closed during negotiation");
        return sync;
      }).catch((error: unknown) => {
        if (!isClosed && error instanceof WireError && (error.code === "unknown-method" || error.code === "not-implemented")) return sync = { mode: "legacy" };
        client.close();
        if (error instanceof WireError && error.code !== "closed") report(error);
        throw error;
      });
    },
    get sync() { return sync; },
    closed,
    close() {
      // Reject pending calls now; the close handshake may take a while to finish.
      shutdown();
      if (socket.readyState <= OPEN) socket.close(1000, "client closed");
    },
  };
  return client;
}
