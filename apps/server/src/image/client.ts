import type { ImageChoice } from "@gates-local/contracts";
import * as S from "effect/Schema";
import { setTimeout as delay } from "node:timers/promises";
import type { ObjectInfo as Info } from "./convert.ts";
import { comfyLists, DEFAULT_CHOICE, jobGraph, resolveChoice, type ComfyLists, type KnownWorkflow, type Preset } from "./presets.ts";
import { comfyFolders, readInstalledSetups } from "./installed.ts";
import { readSaved, readTemplates } from "./sources.ts";
import { graphFacts } from "../pictures/png.ts";

const Device = S.Struct({ type: S.optional(S.String), torch_vram_total: S.optional(S.Finite) });
const Stats = S.Struct({ system: S.Record(S.String, S.Unknown), devices: S.Array(Device) });
const Prompt = S.Struct({ prompt_id: S.String });
const Frame = S.Struct({ type: S.String, data: S.Record(S.String, S.Unknown) });
const Image = S.Struct({ filename: S.String, subfolder: S.optional(S.String), type: S.optional(S.String) });
const History = S.Record(S.String, S.Struct({ outputs: S.Record(S.String, S.Struct({ images: S.optional(S.Array(Image)) })) }));
const Queue = S.Struct({ queue_running: S.Array(S.Array(S.Unknown)), queue_pending: S.Array(S.Array(S.Unknown)) });
const ObjectInfo = S.Record(S.String, S.Unknown);
const failure = (code: string, message: string) => Object.assign(new Error(message), { code });

/** What ComfyUI said it is doing for a prompt (contracts ImageEvent's stage and steps). */
export interface RenderSaid {
  readonly stage: "queued" | "loading" | "encoding" | "sampling" | "decoding";
  readonly steps?: { readonly done: number; readonly total: number };
}
/**
 * The stage a node of this class is, when ComfyUI says it is executing it. A loader that executes
 * reads its model from disk (a loader whose output is cached is not executed, and says nothing);
 * any other class says nothing new.
 */
export function stageOfNode(classType: string): RenderSaid["stage"] | undefined {
  if (/Loader/.test(classType)) return "loading";
  if (/TextEncode/.test(classType)) return "encoding";
  if (/^(KSampler|KSamplerAdvanced|SamplerCustom|SamplerCustomAdvanced)$/.test(classType)) return "sampling";
  if (classType.startsWith("VAEDecode")) return "decoding";
  return undefined;
}

export interface ComfyClientDeps {
  fetch?: typeof fetch;
  socket?: (url: string) => WebSocket;
  requestTimeoutMs?: number;
}

export class ComfyCancelTimeoutError extends Error {
  constructor() { super("ComfyUI did not release the image job within 30 s"); this.name = "ComfyCancelTimeoutError"; }
}

export function createComfyClient(baseUrl: string, deps: ComfyClientDeps = {}) {
  const request = async (route: string, init?: RequestInit, signal?: AbortSignal) => {
    const timeout = AbortSignal.timeout(deps.requestTimeoutMs ?? 10_000);
    const response = await (deps.fetch ?? fetch)(`${baseUrl}${route}`, { ...init, signal: signal ? AbortSignal.any([signal, timeout]) : timeout });
    if (!response.ok) throw new Error(`ComfyUI ${route.split("?")[0]} returned HTTP ${response.status}.`);
    return response;
  };
  const post = (route: string, body: unknown, signal?: AbortSignal) => request(route, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }, signal);
  const queue = async (signal?: AbortSignal) => S.decodeUnknownSync(Queue)(await (await request("/queue", undefined, signal)).json());
  return {
    async stats(signal?: AbortSignal) { return S.decodeUnknownSync(Stats)(await (await request("/system_stats", undefined, signal)).json()); },
    async healthy() {
      try { await this.stats(); return true; }
      catch { return false; }
    },
    /** Nothing queued and nothing running, except possibly `except` (our own prompt stuck past its cancel deadline). */
    async idle(except?: string) { const q = await queue(); return q.queue_pending.length === 0 && q.queue_running.every((row) => except !== undefined && row[1] === except); },
    async running(signal?: AbortSignal) { return (await queue(signal)).queue_running.map((row) => String(row[1])); },
    /** ComfyUI's /object_info answer: every node class with its inputs, including the file lists. */
    async info(signal?: AbortSignal): Promise<Info> {
      return S.decodeUnknownSync(ObjectInfo)(await (await request("/object_info", undefined, signal)).json());
    },
    /** The file lists and node classes ComfyUI reports. */
    async files(signal?: AbortSignal): Promise<ComfyLists> {
      return comfyLists(await this.info(signal));
    },
    /**
     * The file lists and node classes, and the workflows ComfyUI has (sources.ts): its templates and
     * the person's saved ones, each undefined when that list could not be read.
     */
    async catalog(signal?: AbortSignal): Promise<{ lists: ComfyLists; templates?: KnownWorkflow[]; saved?: KnownWorkflow[]; installed?: KnownWorkflow[] }> {
      const info = await this.info(signal);
      const lists = comfyLists(info);
      const get = async (route: string) => (await request(route, undefined, signal)).json() as Promise<unknown>;
      const [templates, saved, installed] = await Promise.all([readTemplates(get, info), readSaved(get, info), readInstalledSetups(get, baseUrl, lists.files)]);
      return { lists, ...templates === undefined ? {} : { templates }, ...saved === undefined ? {} : { saved }, ...installed === undefined ? {} : { installed } };
    },
    /** ComfyUI's model folders by kind (installed.ts comfyFolders), or undefined when it does not say. */
    async folders(signal?: AbortSignal): Promise<Record<string, string[]> | undefined> {
      try { return comfyFolders(await (await request("/internal/folder_paths", undefined, signal)).json()); }
      catch { return undefined; }
    },
    /** `extra`: the workflows ComfyUI had, as setups (presets.ts workflowPreset), for a choice that names one. `seed` omitted: a random one. */
    /** `progress`: the sampler's fraction, and with it what ComfyUI said it is doing, whenever either changes. */
    async render(prompt: string, clientId: string, signal: AbortSignal, progress: (value: number, said?: RenderSaid) => void, fetched: () => void = () => {}, choice: ImageChoice = DEFAULT_CHOICE, extra: readonly Preset[] = [], seed: number = Math.floor(Math.random() * 2 ** 32)): Promise<{ bytes: Buffer; seed: number; steps?: number }> {
      const { preset, size } = resolveChoice(choice, extra);
      const graph = jobGraph(preset, await this.info(signal), { prompt, seed, width: size.width, height: size.height });
      // The steps the graph asks for, for the Pictures screen; a graph with none or several gives none.
      const { steps } = graphFacts(graph);
      // Do not submit into another client's queue.
      if (!await this.idle()) throw failure("image-busy", "ComfyUI is busy with another job. Wait for it to finish, then retry.");
      signal.throwIfAborted();
      const url = new URL(`${baseUrl}/ws`); url.protocol = url.protocol === "https:" ? "wss:" : "ws:"; url.searchParams.set("clientId", clientId);
      const ws = (deps.socket ?? ((address) => new WebSocket(address)))(url.href);
      let promptId: string | undefined;
      let settled = false;
      const isSettled = () => settled;
      let success = false;
      let renderFailure: Error | undefined;
      const pending: { type: string; data: Record<string, unknown> }[] = [];
      let done!: () => void, fail!: (error: Error) => void;
      const completed = new Promise<void>((resolve, reject) => { done = () => { settled = true; resolve(); }; fail = (error) => { settled = true; reject(error); }; });
      // A socket can fail while POST /prompt is still in flight.
      void completed.catch(() => {});
      let fraction = 0, said: RenderSaid | undefined;
      const say = (next: RenderSaid | undefined, value = fraction) => {
        fraction = value;
        said = next;
        progress(fraction, said);
      };
      const handle = (frame: { type: string; data: Record<string, unknown> }) => {
        if (promptId === undefined) { pending.push(frame); return; }
        if (frame.data["prompt_id"] !== promptId) return;
        if (frame.type === "executing" && typeof frame.data["node"] === "string") {
          const stage = stageOfNode(graph[frame.data["node"]]?.class_type ?? "");
          if (stage !== undefined && stage !== said?.stage) say({ stage });
        }
        if (frame.type === "progress") {
          const value = frame.data["value"], max = frame.data["max"];
          if (typeof value === "number" && typeof max === "number" && max > 0) {
            // a tiled decode reports progress too; anything else that counts steps is the sampler
            const counted = { done: Math.round(value), total: Math.round(max) };
            say(said?.stage === "decoding" ? said : { stage: "sampling", steps: counted }, Math.max(0, Math.min(1, value / max)));
          }
        }
        if (frame.type === "execution_success" || (frame.type === "executing" && frame.data["node"] === null)) done();
        if (frame.type === "execution_error" || frame.type === "execution_interrupted") fail(failure("image-workflow", `ComfyUI ${frame.type}: ${String(frame.data["exception_message"] ?? "image did not finish")}`));
      };
      const message = (event: MessageEvent) => {
        if (typeof event.data !== "string") return; // binary preview frames
        try { handle(S.decodeUnknownSync(Frame)(JSON.parse(event.data) as unknown)); } catch { /* unrelated or malformed progress frame */ }
      };
      const closed = () => fail(failure("image-disconnected", "ComfyUI disconnected while making the image. Retry after it is ready."));
      const aborted = () => fail(new Error("Image cancelled."));
      ws.addEventListener("message", message);
      ws.addEventListener("close", closed);
      ws.addEventListener("error", closed);
      signal.addEventListener("abort", aborted, { once: true });
      try {
        if (ws.readyState !== 1) await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(() => finish(new Error("ComfyUI WebSocket did not open.")), 10_000);
          const finish = (openError?: Error) => {
            clearTimeout(timer);
            ws.removeEventListener("open", opened); ws.removeEventListener("error", error); ws.removeEventListener("close", error); signal.removeEventListener("abort", cancel);
            if (openError) reject(openError); else resolve();
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
        say({ stage: "queued" }); // ComfyUI took it: in its queue until a node of it runs
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
        if (!image) throw failure("image-workflow", "ComfyUI finished without an image. Check its workflow and retry.");
        const params = new URLSearchParams({ filename: image.filename, subfolder: image.subfolder ?? "", type: image.type ?? "output" });
        const bytes = Buffer.from(await (await request(`/view?${params}`, undefined, signal)).arrayBuffer());
        if (!bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) throw failure("image-result", "ComfyUI returned a result that is not a PNG.");
        success = true;
        fetched();
        return { bytes, seed, ...steps === undefined ? {} : { steps } };
      } catch (error) {
        renderFailure = error instanceof Error ? error : new Error(String(error));
        throw renderFailure;
      } finally {
        signal.removeEventListener("abort", aborted);
        ws.removeEventListener("message", message); ws.removeEventListener("close", closed); ws.removeEventListener("error", closed); ws.close();
        if (promptId && !success) {
          try { await this.cancelPrompt(promptId); }
          catch (error) {
            // Cleanup must not replace the render failure (especially a dead ComfyUI).
            if (renderFailure) {
              const timedOut = error instanceof ComfyCancelTimeoutError;
              Object.assign(renderFailure, timedOut
                ? { cancelDetail: `${error.message}. ComfyUI may still be running the prompt.`, stuckPromptId: promptId }
                : { cancelDetail: `Stopping the prompt failed: ${error instanceof Error ? error.message : String(error)}.` });
            }
          }
        }
      }
    },
    async cancelPrompt(promptId: string) {
      // Bound cleanup even if Comfy ignores interruption. Chat remeasures real
      // free VRAM before loading after the lease is released.
      const deadline = new AbortController();
      const timeout = setTimeout(() => deadline.abort(new ComfyCancelTimeoutError()), 30_000);
      try {
        for (;;) {
          deadline.signal.throwIfAborted();
          const next = await queue(deadline.signal);
          const pending = next.queue_pending.some((row) => row[1] === promptId);
          const running = next.queue_running.some((row) => row[1] === promptId);
          if (!pending && !running) return;
          if (pending) await post("/queue", { delete: [promptId] }, deadline.signal);
          if (running) await post("/interrupt", { prompt_id: promptId }, deadline.signal);
          await new Promise<void>((resolve, reject) => {
            const finish = () => { deadline.signal.removeEventListener("abort", abort); resolve(); };
            const timer = setTimeout(finish, 100);
            const abort = () => { clearTimeout(timer); reject(deadline.signal.reason); };
            deadline.signal.addEventListener("abort", abort, { once: true });
            if (deadline.signal.aborted) { deadline.signal.removeEventListener("abort", abort); abort(); }
          });
        }
      } catch (error) {
        if (deadline.signal.aborted) throw deadline.signal.reason;
        throw error;
      } finally { clearTimeout(timeout); }
    },
  };
}
