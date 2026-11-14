import { AsyncLocalStorage } from "node:async_hooks";

export interface ServerStages {
  requestId: string;
  threadId: string;
  receive: number;
  modelFetch?: number;
  firstBytes?: number;
  firstSocketDelta?: number;
}
interface SocketPrototype {
  emit(event: string, ...args: unknown[]): boolean;
  send(data: unknown, ...args: unknown[]): unknown;
}
function object(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null; }
function frame(data: unknown): Record<string, unknown> | undefined {
  try { const value: unknown = JSON.parse(String(data)); return object(value) ? value : undefined; } catch { return undefined; }
}

/** A test-only transport observer. No body, address or credentials enter a record. */
export function observeServerStages(socket: SocketPrototype, save: (record: ServerStages) => void, clock = () => performance.timeOrigin + performance.now()) {
  const context = new AsyncLocalStorage<ServerStages>();
  const sends = new Map<string, ServerStages>();
  const emit = socket.emit, send = socket.send, fetch = globalThis.fetch;
  socket.emit = function(event, ...args) {
    const message = event === "message" ? frame(args[0]) : undefined;
    if (message?.["method"] === "chat.send" && typeof message["id"] === "string" && object(message["params"]) && typeof message["params"]["threadId"] === "string") {
      const record = { requestId: message["id"], threadId: message["params"]["threadId"], receive: clock() };
      sends.set(record.threadId, record);
      return context.run(record, () => emit.call(this, event, ...args));
    }
    return emit.call(this, event, ...args);
  };
  socket.send = function(data, ...args) {
    const message = frame(data), payload = message?.["payload"];
    if (message?.["channel"] === "chat.event" && object(payload) && typeof payload["threadId"] === "string" && object(payload["event"]) && payload["event"]["type"] === "delta") {
      const record = sends.get(payload["threadId"]);
      if (record && record.firstSocketDelta === undefined) {
        record.firstSocketDelta = clock();
        // Persist before delegating the send. Teardown can follow immediately.
        save({ ...record });
        sends.delete(record.threadId);
      }
    }
    return send.call(this, data, ...args);
  };
  globalThis.fetch = async function(input, init) {
    const current = context.getStore();
    let record: ServerStages | undefined;
    try {
      if (current && new URL(input instanceof Request ? input.url : String(input)).pathname === "/api/chat" && typeof init?.body === "string") {
        const body: unknown = JSON.parse(init.body);
        if (object(body) && body["stream"] === true && current.modelFetch === undefined) { record = current; record.modelFetch = clock(); }
      }
    } catch { /* Non-model fetches have no stage in a chat record. */ }
    const response = await fetch.call(this, input, init);
    if (record && response.body) {
      const stage = record, getReader = response.body.getReader.bind(response.body);
      // The model client uses the default reader. Preserve the original stream.
      function instrumentedReader(): ReadableStreamDefaultReader<Uint8Array<ArrayBuffer>>;
      function instrumentedReader(options: { mode: "byob" }): ReadableStreamBYOBReader;
      function instrumentedReader(options?: ReadableStreamGetReaderOptions): ReadableStreamReader<Uint8Array<ArrayBuffer>>;
      function instrumentedReader(options?: ReadableStreamGetReaderOptions): ReadableStreamReader<Uint8Array<ArrayBuffer>> {
        if (options?.mode === "byob") return getReader({ mode: "byob" });
        const reader = getReader(), read = reader.read.bind(reader);
        reader.read = async () => {
          const result = await read();
          if (!result.done && result.value?.byteLength && stage.firstBytes === undefined) stage.firstBytes = clock();
          return result;
        };
        return reader;
      }
      response.body.getReader = instrumentedReader;
    }
    return response;
  };
  return () => { socket.emit = emit; socket.send = send; globalThis.fetch = fetch; sends.clear(); context.disable(); };
}
