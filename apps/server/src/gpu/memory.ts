import type { MemoryState, MemoryThing } from "@gates-local/contracts";
import { setTimeout as delay } from "node:timers/promises";
import { VRAM_SAFETY_MARGIN_BYTES } from "../fit/constants.ts";
import { forgetGpuReadings } from "../fit/gpu.ts";
import { sendSpan } from "../chat/send-times.ts";
import { createFifoGate, type LoadGate } from "./gate.ts";
import { canonicalTag } from "../runtime/recommended.ts";
import type { LoadedModel } from "../runtime/types.ts";

export type Want = { readonly kind: "chat"; readonly model: string; readonly numCtx: number } | { readonly kind: "image"; readonly setup: string };

export type EngineLeave = "freed" | "busy" | "absent";

export interface MemoryEngine {
  leave(signal: AbortSignal): Promise<EngineLeave>;
}

export interface Handoff {
  readonly left: readonly string[];
  readonly stayed: readonly string[] | undefined;
  readonly engine: EngineLeave | "kept" | "idle";
}

export interface MemoryOwnerDeps {
  readonly ollamaUrl: () => string | undefined;
  readonly holdsOne?: () => boolean;
  readonly listLoaded: (baseUrl: string, signal: AbortSignal) => Promise<readonly LoadedModel[]>;
  readonly replying: () => readonly string[];
  // why: the image module is made after the memory owner
  readonly engine?: () => MemoryEngine | undefined;
  readonly readFree?: (signal: AbortSignal) => Promise<number | undefined>;
  readonly onUnloaded?: (model: string) => void;
  readonly onChanged?: (state: MemoryState) => void;
  readonly fetch?: typeof fetch;
  readonly waitMs?: number;
  readonly pollMs?: number;
  readonly marginBytes?: number;
  readonly now?: () => number;
  readonly sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  readonly log?: (line: string) => void;
  readonly faultForTest?: "ask-replying-models";
}

export interface LoadedRecord {
  listed(): readonly string[];
  ours(): readonly string[];
  oursAt(model: string): number | undefined;
  loaded(model: string, numCtx: number): readonly (readonly [string, number])[];
  left(model: string): number | undefined;
  observe(listed: readonly Pick<LoadedModel, "name">[]): readonly (readonly [string, number])[];
  clear(): LoadedSnapshot;
  restore(kept: LoadedSnapshot): void;
}

export interface LoadedSnapshot {
  readonly listed: readonly string[];
  readonly ours: readonly (readonly [string, number])[];
}

export function snapshotWithout(kept: LoadedSnapshot, model: string): LoadedSnapshot {
  const tag = canonicalTag(model);
  return { listed: kept.listed.filter((t) => t !== tag), ours: kept.ours.filter(([t]) => t !== tag) };
}

export function createLoadedRecord(holdsOne: () => boolean = () => false): LoadedRecord {
  let listed = new Set<string>();
  const ctxByTag = new Map<string, number>();
  return {
    listed: () => [...listed],
    ours: () => [...ctxByTag.keys()],
    oursAt: (model) => ctxByTag.get(canonicalTag(model)),
    loaded(model, numCtx) {
      const tag = canonicalTag(model);
      const one = holdsOne();
      const gone = one ? [...ctxByTag].filter(([t]) => t !== tag) : [];
      if (one) {
        listed = new Set();
        ctxByTag.clear();
      }
      listed.add(tag);
      ctxByTag.set(tag, numCtx);
      return gone;
    },
    left(model) {
      const tag = canonicalTag(model);
      listed.delete(tag);
      const numCtx = ctxByTag.get(tag);
      ctxByTag.delete(tag);
      return numCtx;
    },
    observe(models) {
      listed = new Set(models.map((m) => canonicalTag(m.name)));
      const gone = [...ctxByTag].filter(([tag]) => !listed.has(tag));
      for (const [tag] of gone) ctxByTag.delete(tag);
      return gone;
    },
    clear() {
      const kept: LoadedSnapshot = { listed: [...listed], ours: [...ctxByTag] };
      listed = new Set();
      ctxByTag.clear();
      return kept;
    },
    restore(kept) {
      listed = new Set(kept.listed);
      ctxByTag.clear();
      for (const [tag, numCtx] of kept.ours) ctxByTag.set(tag, numCtx);
    },
  };
}

export interface MemoryOwner {
  readonly gate: LoadGate;
  readonly loaded: LoadedRecord;
  handoff(want: Want, signal: AbortSignal, options?: { onLeave?: (on: boolean) => void }): Promise<Handoff>;
  stage(want: Want, stage: "measuring" | "loading"): void;
  settled(want: Want): void;
  ended(): void;
  observe(listed: readonly LoadedModel[]): void;
  engineGone(): void;
  status(): MemoryState;
}

export const ENGINE_BUSY_NOTE = "ComfyUI is running another job, so the app did not ask it to free its memory; try again when it finishes.";

export const imageSetup = (choice: { readonly preset: string; readonly width: number; readonly height: number }): string => `${choice.preset} ${choice.width}x${choice.height}`;

export const LEAVE_WAIT_MS = 20_000;
export const LEAVE_POLL_MS = 250;
const SETTLED_BYTES = 64 * 1024 ** 2;
const SETTLED_READS = 2;

const thing = (want: Want, since?: number): MemoryThing =>
  want.kind === "chat" ? { kind: "chat", model: canonicalTag(want.model), numCtx: want.numCtx, ...since === undefined ? {} : { since } } : { kind: "image", setup: want.setup, ...since === undefined ? {} : { since } };

export function createMemoryOwner(deps: MemoryOwnerDeps): MemoryOwner {
  const log = deps.log ?? (() => undefined);
  const now = deps.now ?? Date.now;
  const waitMs = deps.waitMs ?? LEAVE_WAIT_MS;
  const pollMs = deps.pollMs ?? LEAVE_POLL_MS;
  const marginBytes = deps.marginBytes ?? VRAM_SAFETY_MARGIN_BYTES;
  const sleep = deps.sleep ?? ((ms: number, signal: AbortSignal) => delay(ms, undefined, { signal }));
  const gate = createFifoGate();
  let resident: MemoryThing | undefined;
  let handoff: MemoryState["handoff"];
  let engineHolds: string | "unknown" | "empty" = "unknown";
  let said = "";
  // why: the plan counts the old model as free, and a slow driver would put the next one off the card
  const oneChat = (want: Want) => want.kind === "chat" && deps.holdsOne?.() === true;

  const state = (): MemoryState => ({ ...resident === undefined ? {} : { resident }, ...handoff === undefined ? {} : { handoff } });
  const changed = () => {
    const next = state();
    const key = JSON.stringify(next);
    if (key === said) return;
    said = key;
    try {
      deps.onChanged?.(next);
    } catch (e) {
      log(`memory.changed push failed: ${(e as Error).message}`);
    }
  };

  // external: Ollama unloads a model asked with keep_alive 0 once no request uses it.
  const unload = async (baseUrl: string, model: string, signal: AbortSignal): Promise<boolean> => {
    try {
      const res = await (deps.fetch ?? fetch)(new URL("/api/generate", baseUrl), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model, keep_alive: 0 }),
        signal: AbortSignal.any([signal, AbortSignal.timeout(15_000)]),
      });
      await res.arrayBuffer();
      if (!res.ok) log(`unloading ${model}: Ollama HTTP ${res.status}`);
      return res.ok;
    } catch (e) {
      signal.throwIfAborted();
      log(`unloading ${model} failed: ${(e as Error).message}`);
      return false;
    }
  };

  const freeNow = async (signal: AbortSignal) => {
    forgetGpuReadings();
    return await deps.readFree?.(signal);
  };

  const chatLeaves = async (want: Want, signal: AbortSignal, onLeave?: (on: boolean) => void): Promise<{ left: string[]; stayed: string[] | undefined; target?: number }> => {
    const baseUrl = deps.ollamaUrl();
    if (baseUrl === undefined) return { left: [], stayed: [] };
    let listed: readonly LoadedModel[];
    try {
      listed = await deps.listLoaded(baseUrl, signal);
    } catch (e) {
      signal.throwIfAborted();
      log(`reading /api/ps before a handoff failed: ${(e as Error).message}`);
      return { left: [], stayed: undefined };
    }
    const replying = new Set(deps.faultForTest === "ask-replying-models" ? [] : deps.replying().map(canonicalTag));
    // external: Ollama replaces the wanted model's copy at another num_ctx itself, so that model stays.
    const kept = (m: LoadedModel) => want.kind === "chat" && canonicalTag(m.name) === canonicalTag(want.model);
    const busy = listed.filter((m) => !kept(m) && replying.has(canonicalTag(m.name))).map((m) => m.name);
    const asked = listed.filter((m) => !kept(m) && !replying.has(canonicalTag(m.name))).map((m) => m.name);
    if (asked.length === 0) return { left: [], stayed: busy };
    onLeave?.(true);
    const before = oneChat(want) ? await freeNow(signal) : undefined;
    const held = listed.filter((m) => asked.includes(m.name)).reduce((sum, m) => sum + m.sizeVramBytes, 0);
    const target = before === undefined ? {} : { target: before + held };
    for (const model of asked) await unload(baseUrl, model, signal);
    // external: Ollama answers an unload before its runner has gone, so /api/ps is read until it goes.
    const deadline = now() + waitMs;
    let still = new Set(asked.map(canonicalTag));
    for (;;) {
      try {
        const after = await deps.listLoaded(baseUrl, signal);
        const here = new Set(after.map((m) => canonicalTag(m.name)));
        still = new Set([...still].filter((tag) => here.has(tag)));
      } catch (e) {
        signal.throwIfAborted();
        log(`reading /api/ps after an unload failed: ${(e as Error).message}`);
      }
      if (still.size === 0 || now() >= deadline) break;
      await sleep(pollMs, signal);
    }
    const left = asked.filter((m) => !still.has(canonicalTag(m)));
    const url = deps.ollamaUrl();
    if (url === undefined || url === baseUrl) for (const model of left) deps.onUnloaded?.(model);
    return { left, stayed: [...busy, ...asked.filter((m) => still.has(canonicalTag(m)))], ...target };
  };

  const engineLeaves = async (want: Want, signal: AbortSignal): Promise<Handoff["engine"]> => {
    if (want.kind === "image" && engineHolds === want.setup) return "kept";
    if (engineHolds === "empty") return "idle";
    const engine = deps.engine?.();
    if (engine === undefined) return "absent";
    let answer: EngineLeave;
    try {
      answer = await engine.leave(signal);
    } catch (e) {
      signal.throwIfAborted();
      log(`asking the image engine to free its memory failed: ${(e as Error).message}`);
      return "busy";
    }
    if (answer !== "busy") engineHolds = "empty";
    return answer;
  };

  // external: nvidia-smi's free memory can lag a runner's exit by a read, so one flat read is not enough.
  const settle = async (signal: AbortSignal, target?: number) => {
    if (deps.readFree === undefined) return;
    const deadline = now() + waitMs;
    let before = await freeNow(signal);
    if (before === undefined) return;
    if (target !== undefined) {
      while (before < target - marginBytes && now() < deadline) {
        await sleep(pollMs, signal);
        const after = await freeNow(signal);
        if (after === undefined) return;
        before = after;
      }
      return;
    }
    let flat = 0;
    while (now() < deadline) {
      await sleep(pollMs, signal);
      const after = await freeNow(signal);
      if (after === undefined) return;
      flat = after - before < SETTLED_BYTES ? flat + 1 : 0;
      if (flat >= SETTLED_READS) return;
      before = after;
    }
  };

  return {
    gate,
    loaded: createLoadedRecord(() => deps.holdsOne?.() === true),
    async handoff(want, signal, options = {}) {
      handoff = { to: thing(want), stage: "leaving" };
      changed();
      let told = false;
      const tell = (on: boolean) => {
        if (on === told) return;
        told = on;
        options.onLeave?.(on);
      };
      try {
        const chat = await sendSpan("chat-leave", () => chatLeaves(want, signal, tell));
        const engine = await sendSpan("engine-leave", () => engineLeaves(want, signal));
        if (engine === "freed") tell(true);
        if (chat.left.length > 0 || engine === "freed") {
          const was = resident;
          if (was?.kind === "image" && engine === "freed") resident = undefined;
          if (was?.kind === "chat" && chat.left.some((m) => canonicalTag(m) === was.model)) resident = undefined;
          try {
            await sendSpan("settle", () => settle(signal, chat.target));
          } catch (e) {
            signal.throwIfAborted();
            log(`reading the GPU after a handoff failed: ${(e as Error).message}`);
          }
          forgetGpuReadings();
        }
        tell(false);
        handoff = { to: thing(want), stage: "measuring" };
        changed();
        return { left: chat.left, stayed: chat.stayed, engine };
      } catch (e) {
        tell(false);
        handoff = undefined;
        changed();
        throw e;
      }
    },
    stage(want, stage) {
      handoff = { to: thing(want), stage };
      changed();
    },
    settled(want) {
      const was = resident;
      const same = was?.kind === "chat" ? want.kind === "chat" && was.model === canonicalTag(want.model) && was.numCtx === want.numCtx : was?.kind === "image" && want.kind === "image" && was.setup === want.setup;
      if (!same) resident = thing(want, now());
      if (want.kind === "image") engineHolds = want.setup;
      handoff = undefined;
      changed();
    },
    ended() {
      if (handoff?.to.kind === "image" && handoff.stage === "loading") engineHolds = "unknown";
      handoff = undefined;
      changed();
    },
    observe(listed) {
      if (resident?.kind === "chat") {
        const model = canonicalTag(resident.model);
        if (listed.some((m) => canonicalTag(m.name) === model)) return;
        resident = undefined;
      }
      if (resident === undefined && listed.length > 0) {
        const first = listed[0]!;
        resident = { kind: "chat", model: canonicalTag(first.name), ...first.contextLength === undefined ? {} : { numCtx: first.contextLength }, since: now() };
      }
      changed();
    },
    engineGone() {
      engineHolds = "empty";
      if (resident?.kind === "image") resident = undefined;
      changed();
    },
    status: state,
  };
}
