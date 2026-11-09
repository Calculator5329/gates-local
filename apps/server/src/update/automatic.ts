export interface AutomaticCheckOptions {
  readonly desktop: boolean;
  readonly enabled: () => boolean;
  readonly check: () => Promise<unknown>;
  readonly onChange: (listener: () => void) => () => void;
}

/** One timer per desktop server, never one per connected client. It only checks. */
export function automaticChecks(options: AutomaticCheckOptions): () => void {
  if (!options.desktop) return () => undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let stopped = false;
  let checking = false;
  const schedule = (ms: number) => {
    clearTimeout(timer);
    timer = undefined;
    if (stopped || !options.enabled()) return;
    timer = setTimeout(() => {
      timer = undefined;
      if (stopped || !options.enabled() || checking) return;
      checking = true;
      void options.check().catch(() => undefined).finally(() => {
        checking = false;
        schedule(3_600_000);
      });
    }, ms);
    timer.unref?.();
  };
  const off = options.onChange(() => schedule(15_000));
  schedule(15_000);
  return () => { stopped = true; clearTimeout(timer); off(); };
}
