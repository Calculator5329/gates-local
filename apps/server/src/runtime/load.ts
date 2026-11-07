// Models moving into memory, and which of them this app put there.
//
// models.load runs the fit check and, unless it refuses, preloads with an
// empty /api/generate. A chat turn whose model is not in /api/ps pushes
// "loading" and then "ready" at its first token. Either way the model joins
// appLoadedModels(), the one list the image lane may unload from; a model
// someone else loaded (a terminal `ollama run`, another app) never does.
// The list is pruned against /api/ps whenever this module or the GPU poll
// reads it, so a model Ollama let go of leaves it ("unloaded" push).
import type { FitReport, ModelLoad } from "@gates-local/contracts";
import { canonicalTag } from "./recommended.ts";
import type { LoadedModel } from "./types.ts";

/**
 * keep_alive for a preload: Ollama's own default, so a preloaded model stays
 * exactly as long as one a turn started (each turn's request resets it).
 */
export const PRELOAD_KEEP_ALIVE = "5m";
/** A cold load of a large model from disk can take minutes. */
const PRELOAD_TIMEOUT_MS = 10 * 60_000;

export type ModelErrorCode = "model-in-use" | "runtime-not-ready" | "remove-failed";

/** A refused models.* action; the ws layer sends `code` to the client. */
export class ModelActionError extends Error {
  override readonly name = "ModelActionError";
  readonly code: ModelErrorCode;
  constructor(code: ModelErrorCode, message: string) {
    super(message);
    this.code = code;
  }
}

export interface TurnLoad {
  /** The turn's first token (or any first event): the model answered. */
  firstToken(): void;
  /** The turn is over, however it ended. */
  end(): void;
}

export interface ModelLoader {
  load(model: string, numCtx: number): Promise<ModelLoad>;
  /** Called as a chat turn starts streaming. Synchronous so the turn is counted at once. */
  beginTurn(model: string, numCtx: number): TurnLoad;
  /** A turn is streaming with this model now. */
  inUse(model: string): boolean;
  /** Models this app loaded that are still resident, by tag. */
  appLoadedModels(): readonly string[];
  /** Drops models no longer in /api/ps; the GPU poll feeds its own reading here. */
  prune(resident: readonly string[]): void;
}

export interface ModelLoaderDeps {
  readonly baseUrl: () => string | undefined;
  readonly push: (load: ModelLoad) => void;
  readonly listLoaded: (baseUrl: string) => Promise<readonly LoadedModel[]>;
  /** The fit check for models.load. */
  readonly fit: (model: string, numCtx: number) => Promise<FitReport>;
  /** After a load the app caused, so the GPU status refreshes (gpu watcher poke). */
  readonly onLoaded?: () => void;
  readonly log?: (line: string) => void;
}

export function createModelLoader(deps: ModelLoaderDeps): ModelLoader {
  const log = deps.log ?? (() => undefined);
  /** Tag -> the num_ctx it was loaded at. */
  const owned = new Map<string, number>();
  const turnsByModel = new Map<string, number>();

  const send = (load: ModelLoad) => {
    try {
      deps.push(load);
    } catch (e) {
      log(`models.load push failed: ${(e as Error).message}`);
    }
  };

  const loaded = (model: string, numCtx: number) => {
    owned.set(canonicalTag(model), numCtx);
    send({ model, numCtx, state: "ready" });
    deps.onLoaded?.();
  };

  const prune = (resident: readonly string[]) => {
    const here = new Set(resident.map(canonicalTag));
    for (const [tag, numCtx] of owned) {
      if (here.has(tag)) continue;
      owned.delete(tag);
      send({ model: tag, numCtx, state: "unloaded" });
    }
  };

  /** /api/ps names, pruning the owned list on the way; undefined when it cannot be read. */
  const resident = async (baseUrl: string): Promise<Set<string> | undefined> => {
    try {
      const names = (await deps.listLoaded(baseUrl)).map((m) => m.name);
      prune(names);
      return new Set(names.map(canonicalTag));
    } catch (e) {
      log(`reading /api/ps failed: ${(e as Error).message}`);
      return undefined;
    }
  };

  return {
    async load(model, numCtx) {
      const baseUrl = deps.baseUrl();
      if (baseUrl === undefined) throw new ModelActionError("runtime-not-ready", "Ollama is not running, so no model can be loaded.");
      const report = await deps.fit(model, numCtx);
      if (report.verdict === "refuse") {
        const refused: ModelLoad = { model, numCtx, state: "error", message: report.message ?? `${model} at num_ctx ${numCtx} does not fit.` };
        send(refused);
        return refused;
      }
      send({ model, numCtx, state: "loading" });
      try {
        const res = await fetch(new URL("/api/generate", baseUrl), {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ model, prompt: "", stream: false, keep_alive: PRELOAD_KEEP_ALIVE, options: { num_ctx: numCtx } }),
          signal: AbortSignal.timeout(PRELOAD_TIMEOUT_MS),
        });
        if (!res.ok) {
          const text = await res.text().catch(() => "");
          let message = text || `HTTP ${res.status}`;
          try {
            const parsed = JSON.parse(text) as { error?: unknown };
            if (typeof parsed.error === "string") message = parsed.error;
          } catch {
            // keep the raw text
          }
          throw new Error(message);
        }
        await res.body?.cancel();
      } catch (e) {
        const failed: ModelLoad = { model, numCtx, state: "error", message: `Could not load ${model}: ${(e as Error).message}` };
        send(failed);
        return failed;
      }
      loaded(model, numCtx);
      return { model, numCtx, state: "ready" };
    },

    beginTurn(model, numCtx) {
      const tag = canonicalTag(model);
      turnsByModel.set(tag, (turnsByModel.get(tag) ?? 0) + 1);
      const baseUrl = deps.baseUrl();
      let pushedLoading = false;
      let answered = false;
      let ended = false;
      const checked = (async () => {
        if (baseUrl === undefined) return;
        const here = await resident(baseUrl);
        // Unreadable /api/ps: say nothing rather than guess.
        if (here === undefined || here.has(tag) || answered) return;
        pushedLoading = true;
        send({ model, numCtx, state: "loading" });
      })();
      return {
        firstToken() {
          if (answered) return;
          answered = true;
          void checked.then(() => {
            if (pushedLoading) loaded(model, numCtx);
          });
        },
        end() {
          if (ended) return;
          ended = true;
          const left = (turnsByModel.get(tag) ?? 1) - 1;
          if (left > 0) turnsByModel.set(tag, left);
          else turnsByModel.delete(tag);
          if (answered || baseUrl === undefined) return;
          // Ended before a token (an error or a cancel mid-load): report what is true now.
          void checked.then(async () => {
            if (!pushedLoading) return;
            const here = await resident(baseUrl);
            if (here?.has(tag)) loaded(model, numCtx);
            else send({ model, numCtx, state: "unloaded" });
          });
        },
      };
    },

    inUse: (model) => (turnsByModel.get(canonicalTag(model)) ?? 0) > 0,
    appLoadedModels: () => [...owned.keys()],
    prune,
  };
}
