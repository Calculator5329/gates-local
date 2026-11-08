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

export interface CallOptions {
  readonly timeoutMs?: number;
}

export interface Client {
  call<M extends MethodName>(method: M, params: Params<M>, options?: CallOptions): Promise<ResultOf<M>>;
  subscribe<C extends Channel>(channel: C, handler: (payload: Payload<C>) => void): () => void;
  /** Resolves when the socket has closed; every pending call is rejected with code "closed" by then. */
  readonly closed: Promise<void>;
  close(): void;
}

interface Pending {
  readonly method: MethodName;
  readonly resolve: (value: never) => void;
  readonly reject: (error: WireError) => void;
  readonly timer: ReturnType<typeof setTimeout>;
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
  const report = options.onProtocolError ?? ((e: WireError) => console.warn(`[contracts] ${e.code}: ${e.message}`));
  const pending = new Map<string, Pending>();
  const outbox: Array<readonly [frame: string, id: string]> = [];
  const subscribers = new Map<Channel, Set<(payload: never) => void>>();
  let nextId = 1;
  let isClosed = socket.readyState > OPEN;
  let markClosed!: () => void;
  const closed = new Promise<void>((resolve) => {
    markClosed = resolve;
  });

  const onOpen = () => {
    for (const [frame, id] of outbox.splice(0)) transmit(frame, id);
  };

  const onMessage = (event: { data?: unknown }) => {
    const decoded = decodeServerMessage(frameText(event.data));
    if (!decoded.ok) return report(decoded.error);
    const msg = decoded.value;
    if (msg.type === "push") {
      const p = decodePayload(msg.channel, msg.payload);
      if (!p.ok) return report(p.error);
      for (const handler of subscribers.get(p.value.channel) ?? []) {
        try {
          handler(p.value.payload as never);
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
    if (!msg.ok) return call.reject(new WireError(msg.error.code, msg.error.message, msg.error.blocking));
    const r = decodeResult(call.method, msg.result);
    if (r.ok) call.resolve(r.value as never);
    else call.reject(r.error);
  };

  let listening = true;
  const shutdown = () => {
    isClosed = true;
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

  return {
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
        pending.set(id, { method, resolve: resolve as (value: never) => void, reject, timer });
        if (socket.readyState === CONNECTING) outbox.push([frame.value, id]);
        else transmit(frame.value, id);
      });
    },
    subscribe(channel, handler) {
      let set = subscribers.get(channel);
      if (set === undefined) subscribers.set(channel, (set = new Set()));
      set.add(handler as (payload: never) => void);
      return () => {
        set.delete(handler as (payload: never) => void);
      };
    },
    closed,
    close() {
      // Reject pending calls now; the close handshake may take a while to finish.
      shutdown();
      if (socket.readyState <= OPEN) socket.close(1000, "client closed");
    },
  };
}
