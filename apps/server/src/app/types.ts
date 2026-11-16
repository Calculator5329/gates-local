// What createApp takes and what it gives back (app.ts wires them together).
import type { ImageChoice, Message, ShellStatus } from "@gates-local/contracts";
import type { FitDeps } from "../fit/fit.ts";
import type { FitTableSource } from "../fit/table.ts";
import type { GpuLease } from "../gpu/lease.ts";
import type { ImageModule } from "../image/module.ts";
import type { ImageSetupModule } from "../image/setup.ts";
import type { MeasureDeps } from "../measure/handlers.ts";
import type { ModelLoader } from "../runtime/load.ts";
import type { ModelCatalog } from "../runtime/models.ts";
import type { RuntimeSwitch } from "../runtime/switch.ts";
import type { SettingsReader } from "../settings/store.ts";
import type { LibraryImports } from "../sources/imports.ts";
import type { Sources } from "../sources/index.ts";
import type { ThreadStore } from "../threads/store.ts";
import type { UpdateModule } from "../update/module.ts";
import type { Usage } from "../usage/index.ts";
import type { Handlers } from "../ws/server.ts";
import type { Push } from "./push.ts";

/** The methods every build answers. The others join with their modules; until then the socket answers "not-implemented". */
type CoreMethod =
  | "threads.list"
  | "threads.create"
  | "threads.get"
  | "threads.rename"
  | "threads.delete"
  | "models.list"
  | "models.refresh"
  | "runtime.status"
  | "fit.table"
  | "chat.send"
  | "chat.cancel";
export type AppHandlers = Pick<Handlers, CoreMethod> & Partial<Handlers>;

export interface AppDeps {
  readonly admit?: () => void;
  readonly dataDir?: string;
  readonly store: ThreadStore;
  readonly runtime: Pick<RuntimeSwitch, "status" | "baseUrl" | "onChange" | "ensure" | "lookIfDown">;
  readonly catalog: ModelCatalog;
  /** Bound late: main creates the ws server after the handlers. */
  readonly push: Push;
  /** nvidia-smi, meminfo, clock and margins for the fit check; defaults read the real machine. */
  readonly fit?: Omit<FitDeps, "baseUrl">;
  /** Ollama's think flag for every turn; omitted from the request when undefined. */
  readonly think?: boolean;
  readonly settings?: Pick<SettingsReader, "get">;
  readonly sources?: Sources;
  readonly libraryImports?: LibraryImports;
  readonly toolsEnabled?: () => boolean;
  /** The shell sandbox's probe (cached; a failed one is asked again after a while). Unset: the shell is offered unchecked. */
  readonly shellStatus?: () => Promise<ShellStatus>;
  readonly newId?: () => string;
  readonly log?: (line: string) => void;
  /** How often a streaming reply is rewritten on disk; a crash loses at most this much. Defaults to a second. */
  readonly draftEveryMs?: number;
  /**
   * Settings, GPU status, catalog, downloads and preloading (built in main
   * from settings/, fit/ and runtime/), plus the loader: a turn reserves its
   * model before its first await and runs its fit inside the load gate
   * (admit), which pushes models.load around a turn whose model is not resident.
   */
  readonly models?: { readonly handlers: Partial<Handlers>; readonly loader?: Pick<ModelLoader, "reserve"> };
  /** Image jobs: chat.send draw (Image mode) and a chat turn's image tool queue them here for their thread. */
  readonly image?: ImageModule;
  /** Set up images: the app's own ComfyUI and this card's setup, one download (image/setup.ts). */
  readonly imageSetup?: ImageSetupModule;
  /**
   * Tools › Make images: the preset and size a chat turn's image tool uses, or undefined while
   * that switch (or image generation) is off and no chat turn is offered the tool.
   */
  readonly imageTool?: () => ImageChoice | undefined;
  /**
   * The system prompt's line for a chat turn the image tool is not offered to: what turns it on
   * here, so the model never names another app. `toolsOn`: the turn runs tools.
   */
  readonly imageOff?: (toolsOn: boolean) => string | undefined;
  /**
   * The app's one GPU lease. A turn holds a shared chat claim from just after
   * its reservation to its end, so an image job never runs beside a stream.
   */
  readonly lease?: Pick<GpuLease, "acquire">;
  /** The one owner of what is in memory (gpu/memory.ts): Measure hands off through it. Sends reach it through the loader. */
  readonly memory?: MeasureDeps["memory"];
  /** Settings › Updates: the version, the one-click check and the last update's result (update/module.ts). */
  readonly update?: UpdateModule;
  /** Token counts per hour and model (usage/); each model request's done line records here. */
  readonly usage?: Pick<Usage, "record">;
}

export interface App {
  readonly handlers: AppHandlers;
  /** Turns streaming now (or reserved and starting). */
  activeTurns(): number;
  windowGone(window: number): void;
  /**
   * For in-process callers (tests, the crash server): the saved question of a turn chat.send has
   * just answered, once it starts, or its refusal. Undefined once the turn has ended.
   */
  admission(turnId: string): Promise<Message> | undefined;
  /** The fit table: main feeds it the GPU watcher's gpu.changed and the loader's models.load. */
  readonly fitTable: Pick<FitTableSource, "changed" | "load">;
  /** Refuse new turns, cancel the active ones and wait for them to end. Idempotent. */
  shutdown(): Promise<void>;
  /** A picture's thumbnail, made in the image files' queue when missing (pictures/thumbs.ts). */
  thumbnail(jobId: string): Promise<Buffer | undefined>;
}
