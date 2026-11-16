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
import type { TurnSaid } from "./turn.ts";

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
  | "reply.send"
  | "reply.change"
  | "reply.edit"
  | "reply.remove"
  | "reply.now"
  | "reply.hold"
  | "reply.stop"
  | "reply.list";
export type AppHandlers = Pick<Handlers, CoreMethod> & Partial<Handlers>;

export interface AppDeps {
  readonly admit?: () => void;
  readonly dataDir?: string;
  readonly store: ThreadStore;
  readonly runtime: Pick<RuntimeSwitch, "status" | "baseUrl" | "onChange" | "ensure" | "lookIfDown">;
  readonly catalog: ModelCatalog;
  // why: main creates the ws server after the handlers, so push is bound late
  readonly push: Push;
  // why: tests read each turn's events here; no window hears them
  readonly turnSaid?: (said: TurnSaid) => void;
  readonly fit?: Omit<FitDeps, "baseUrl">;
  // external: Ollama's /api/chat takes an optional boolean think
  readonly think?: boolean;
  readonly settings?: Pick<SettingsReader, "get">;
  readonly sources?: Sources;
  readonly libraryImports?: LibraryImports;
  readonly toolsEnabled?: () => boolean;
  readonly shellStatus?: () => Promise<ShellStatus>;
  readonly newId?: () => string;
  readonly log?: (line: string) => void;
  readonly draftEveryMs?: number;
  readonly models?: { readonly handlers: Partial<Handlers>; readonly loader?: Pick<ModelLoader, "reserve"> };
  readonly image?: ImageModule;
  readonly imageSetup?: ImageSetupModule;
  readonly imageTool?: () => ImageChoice | undefined;
  readonly imageOff?: (toolsOn: boolean) => string | undefined;
  readonly lease?: Pick<GpuLease, "acquire">;
  readonly memory?: MeasureDeps["memory"];
  readonly update?: UpdateModule;
  readonly usage?: Pick<Usage, "record">;
}

export interface App {
  readonly handlers: AppHandlers;
  activeTurns(): number;
  windowGone(window: number): void;
  started(id: string): { readonly turnId: string; readonly admission: Promise<Message> } | undefined;
  readonly fitTable: Pick<FitTableSource, "changed" | "load">;
  shutdown(): Promise<void>;
  thumbnail(jobId: string): Promise<Buffer | undefined>;
}
