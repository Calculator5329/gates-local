import { Option, Schema as S } from "effect";
import { setTimeout as delay } from "node:timers/promises";
import { CHECKPOINT, LORA, workflow } from "./workflow.ts";

const Stats = S.Struct({ system: S.Record(S.String, S.Unknown), devices: S.Array(S.Unknown) });
const Prompt = S.Struct({ prompt_id: S.String });
const Frame = S.Struct({ type: S.String, data: S.Record(S.String, S.Unknown) });
const Image = S.Struct({ filename: S.String, subfolder: S.optional(S.String), type: S.optional(S.String) });
const History = S.Record(S.String, S.Struct({ outputs: S.Record(S.String, S.Struct({ images: S.optional(S.Array(Image)) })) }));
const Queue = S.Struct({ queue_running: S.Array(S.Array(S.Unknown)), queue_pending: S.Array(S.Array(S.Unknown)) });
const ObjectInfo = S.Record(S.String, S.Unknown);
const LoaderInfo = S.Struct({ input: S.Struct({ required: S.Record(S.String, S.Array(S.Unknown)) }) });

export interface ComfyClientDeps {
  fetch?: typeof fetch;
  socket?: (url: string) => WebSocket;
  requestTimeoutMs?: number;
}

export function createComfyClient(baseUrl: string, deps: ComfyClientDeps = {}) {
  const request = async (route: string, init?: RequestInit, signal?: AbortSignal) => {
    const timeout = AbortSignal.timeout(deps.requestTimeoutMs ?? 10_000);
    const response = await (deps.fetch ?? fetch)(`${baseUrl}${route}`, { ...init, signal: signal ? AbortSignal.any([signal, timeout]) : timeout });
    if (!response.ok) throw new Error(`ComfyUI ${route.split("?")[0]} returned HTTP ${response.status}.`);
    return response;
  };
  const post = (route: string, body: unknown) => request(route, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const queue = async () => S.decodeUnknownSync(Queue)(await (await request("/queue")).json());
  return {
    async healthy() {
      try { S.decodeUnknownSync(Stats)(await (await request("/system_stats")).json()); return true; }
      catch { return false; }
    },
    async idle() { const q = await queue(); return q.queue_running.length === 0 && q.queue_pending.length === 0; },
    async render(prompt: string, clientId: string, signal: AbortSignal, progress: (value: number) => void): Promise<Buffer> {
      const info = S.decodeUnknownSync(ObjectInfo)(await (await request("/object_info", undefined, signal)).json());
      const select = (node: string, field: string, wanted: string) => {
        const loader = S.decodeUnknownOption(LoaderInfo)(info[node]);
        const choices = Option.isSome(loader) ? loader.value.input.required[field]?.[0] : undefined;
        const choice = Array.isArray(choices) ? choices.find((v: unknown) => typeof v === "string" && (v === wanted || v.replaceAll("\\", "/").endsWith(`/${wanted}`))) : undefined;
        if (typeof choice !== "string") throw new Error(`ComfyUI model ${wanted} is absent. Install it in ComfyUI's model folders, then retry.`);
        return choice;
      };
      const graph = workflow(prompt, Math.floor(Math.random() * 2 ** 32), select("CheckpointLoaderSimple", "ckpt_name", CHECKPOINT), select("LoraLoader", "lora_name", LORA));
      // /interrupt is global. Do not submit into another client's queue.
      if (!await this.idle()) throw new Error("ComfyUI is busy with another job. Wait for it to finish, then retry.");
      signal.throwIfAborted();
      const url = new URL(`${baseUrl}/ws`); url.protocol = url.protocol === "https:" ? "wss:" : "ws:"; url.searchParams.set("clientId", clientId);
      const ws = (deps.socket ?? ((address) => new WebSocket(address)))(url.href);
      let promptId: string | undefined;
      let settled = false;
      const isSettled = () => settled;
      let success = false;
      const pending: { type: string; data: Record<string, unknown> }[] = [];
      let done!: () => void, fail!: (error: Error) => void;
      const completed = new Promise<void>((resolve, reject) => { done = () => { settled = true; resolve(); }; fail = (error) => { settled = true; reject(error); }; });
      // A socket can fail while POST /prompt is still in flight.
      void completed.catch(() => {});
      const handle = (frame: { type: string; data: Record<string, unknown> }) => {
        if (promptId === undefined) { pending.push(frame); return; }
        if (frame.data["prompt_id"] !== promptId) return;
        if (frame.type === "progress") {
          const value = frame.data["value"], max = frame.data["max"];
          if (typeof value === "number" && typeof max === "number" && max > 0) progress(Math.max(0, Math.min(1, value / max)));
        }
        if (frame.type === "execution_success" || (frame.type === "executing" && frame.data["node"] === null)) done();
        if (frame.type === "execution_error" || frame.type === "execution_interrupted") fail(new Error(`ComfyUI ${frame.type}: ${String(frame.data["exception_message"] ?? "image did not finish")}`));
      };
      const message = (event: MessageEvent) => {
        if (typeof event.data !== "string") return; // binary preview frames
        try { handle(S.decodeUnknownSync(Frame)(JSON.parse(event.data) as unknown)); } catch { /* unrelated or malformed progress frame */ }
      };
      const closed = () => fail(new Error("ComfyUI disconnected while making the image. Retry after it is ready."));
      const aborted = () => fail(new Error("Image cancelled."));
      ws.addEventListener("message", message);
      ws.addEventListener("close", closed);
      ws.addEventListener("error", closed);
      signal.addEventListener("abort", aborted, { once: true });
      try {
        if (ws.readyState !== 1) await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(() => finish(new Error("ComfyUI WebSocket did not open.")), 10_000);
          const finish = (failure?: Error) => {
            clearTimeout(timer);
            ws.removeEventListener("open", opened); ws.removeEventListener("error", error); ws.removeEventListener("close", error); signal.removeEventListener("abort", cancel);
            if (failure) reject(failure); else resolve();
          };
          const opened = () => finish();
          const error = () => finish(new Error("ComfyUI WebSocket failed to open."));
          const cancel = () => finish(new Error("Image cancelled."));
          ws.addEventListener("open", opened, { once: true }); ws.addEventListener("error", error, { once: true }); ws.addEventListener("close", error, { once: true }); signal.addEventListener("abort", cancel, { once: true });
          if (signal.aborted) cancel();
        });
        signal.throwIfAborted();
        // Do not abort submission: retain prompt_id if cancellation races server acceptance.
        promptId = S.decodeUnknownSync(Prompt)(await (await post("/prompt", { prompt: graph, client_id: clientId })).json()).prompt_id;
        for (const frame of pending) handle(frame);
        if (signal.aborted) aborted();
        // History also handles cache hits and keeps failure bounded if progress stops.
        const pollAbort = new AbortController();
        const poll = async () => {
          while (!isSettled()) {
            await delay(1000, undefined, { signal: pollAbort.signal });
            const history = S.decodeUnknownSync(History)(await (await request(`/history/${encodeURIComponent(promptId ?? "")}`)).json());
            if (promptId && history[promptId]) { done(); return; }
          }
        };
        const polling = poll().catch((e: unknown) => { if (!pollAbort.signal.aborted) fail(e instanceof Error ? e : new Error(String(e))); });
        try { await completed; } finally { pollAbort.abort(); await polling; }
        signal.throwIfAborted();
        const history = S.decodeUnknownSync(History)(await (await request(`/history/${encodeURIComponent(promptId)}`, undefined, signal)).json());
        const image = Object.values(history[promptId]?.outputs ?? {}).flatMap((output) => output.images ?? [])[0];
        if (!image) throw new Error("ComfyUI finished without an image. Check its workflow and retry.");
        const params = new URLSearchParams({ filename: image.filename, subfolder: image.subfolder ?? "", type: image.type ?? "output" });
        const bytes = Buffer.from(await (await request(`/view?${params}`, undefined, signal)).arrayBuffer());
        if (!bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) throw new Error("ComfyUI returned a result that is not a PNG.");
        success = true;
        return bytes;
      } finally {
        signal.removeEventListener("abort", aborted);
        ws.removeEventListener("message", message); ws.removeEventListener("close", closed); ws.removeEventListener("error", closed); ws.close();
        if (promptId && !success) await this.cancelPrompt(promptId);
      }
    },
    async cancelPrompt(promptId: string) {
      // Keep the lease until Comfy confirms our prompt has left both queues.
      // If Comfy dies the failed request ends this wait, too.
      for (;;) {
        const next = await queue();
        const pending = next.queue_pending.some((row) => row[1] === promptId);
        const running = next.queue_running.some((row) => row[1] === promptId);
        if (!pending && !running) return;
        if (pending) await post("/queue", { delete: [promptId] });
        if (running) await post("/interrupt", {});
        await delay(100);
      }
    },
  };
}
