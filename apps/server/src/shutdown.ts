// The server's shared stdin/signal shutdown path. Keep cancellation and joins
// here so one slow resource cannot prevent another producer being signalled.
type Closing = { close(): unknown };
export interface ShutdownResources {
  admission: Closing;
  stopAutomatic(): void;
  app: { shutdown(): unknown };
  update: Closing;
  imports: Closing;
  loader: Closing;
  image: Closing & { killRuntimeNow(): void };
  server(): Closing | undefined;
  store: Closing;
  models: Closing & { killRuntimeNow(): void };
  log(line: string): void;
  exit?: (code: number) => void;
}
export const HARD_EXIT_MS = 2500;

export function createServerShutdown(resources: ShutdownResources) {
  let stopping = false;
  const shutdown = async (why: string) => {
    if (stopping) return;
    stopping = true;
    resources.admission.close();
    resources.stopAutomatic();
    resources.log(`shutting down (${why})`);
    const exit = resources.exit ?? process.exit;
    const timer = setTimeout(() => {
      resources.log(`shutdown took over ${HARD_EXIT_MS} ms; exiting anyway`);
      resources.models.killRuntimeNow();
      resources.image.killRuntimeNow();
      exit(1);
    }, HARD_EXIT_MS);
    const step = async (name: string, fn: () => unknown) => {
      try { await fn(); }
      catch (error) { resources.log(`${name} failed: ${(error as Error).message}`); }
    };
    // Begin cancellation before any drain can stall. Join snapshot workers
    // and their cleanup while a slow fetch is still pending.
    const importsClosing = step("finish imports", () => resources.imports.close());
    const updateClosing = step("finish update check", () => resources.update.close());
    await step("cancel turns", () => resources.app.shutdown());
    await importsClosing;
    await updateClosing;
    // A preload holds a shared GPU claim; image close needs it alone.
    await step("drain model loads", () => resources.loader.close());
    await step("close image module", () => resources.image.close());
    await step("close ws", () => resources.server()?.close());
    await step("close store", () => resources.store.close());
    await step("close models", () => resources.models.close());
    clearTimeout(timer);
    exit(0);
  };
  return Object.assign(shutdown, { stopping: () => stopping });
}
