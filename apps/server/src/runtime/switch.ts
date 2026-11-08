// The runtime the rest of the server talks to, following Settings'
// runtimeMode. A switch makes a fresh runtime for the new mode and runs its
// discovery (ensure), and its status changes reach onChange listeners, so
// app.ts pushes runtime.changed as usual. The system Ollama is never
// stopped. The app's own copy is stopped on a switch only when this
// process started it; one adopted from an earlier run keeps running.
import type { RuntimeMode, RuntimeStatus } from "@gates-local/contracts";
import type { OllamaRuntime } from "./runtime.ts";
import type { Listener } from "./types.ts";

export interface RuntimeSwitch extends Pick<OllamaRuntime, "status" | "baseUrl" | "onChange" | "ensure" | "discover" | "startedByThisProcess"> {
  mode(): RuntimeMode;
  /** Switch modes and ensure the new runtime; resolves with its status. Same mode: no-op. */
  setMode(mode: RuntimeMode): Promise<RuntimeStatus>;
  /** Stop the app's own copy if this process started it (server shutdown). */
  stopIfStartedHere(): Promise<void>;
}

export interface RuntimeSwitchOptions {
  readonly initialMode: RuntimeMode;
  readonly make: (mode: RuntimeMode) => OllamaRuntime;
  /**
   * Before a switch takes effect (abort downloads and turns bound to the old
   * runtime). The old runtime stops only after its promise settles.
   */
  readonly beforeSwitch?: () => void | Promise<void>;
  /** Once the new runtime's ensure settled, however it went (always paired with beforeSwitch). */
  readonly afterSwitch?: () => void;
  readonly log?: (line: string) => void;
}

export function createRuntimeSwitch(options: RuntimeSwitchOptions): RuntimeSwitch {
  const listeners = new Set<Listener<RuntimeStatus>>();
  let mode = options.initialMode;
  let inner = options.make(mode);
  let lastSent: string | undefined;
  const forward = (s: RuntimeStatus) => {
    const key = JSON.stringify(s);
    if (key === lastSent) return;
    lastSent = key;
    for (const l of listeners) l(s);
  };
  let off = inner.onChange(forward);
  /**
   * From a switch's first line until its ensure settles: baseUrl() is
   * undefined, so nothing new is sent to the runtime being stopped (or to a
   * new one that is not ready yet).
   */
  let switching = false;
  // ensure, discover, setMode and stopIfStartedHere run one after another, so
  // a switch waits for an outstanding startup to settle before it decides
  // whether the old runtime was started here (no orphaned app Ollama).
  let chain: Promise<unknown> = Promise.resolve();
  const serial = <T>(fn: () => Promise<T>): Promise<T> => {
    const run = chain.then(fn);
    chain = run.catch(() => undefined);
    return run;
  };

  const stopIfStartedHere = async (rt: OllamaRuntime) => {
    if (!rt.startedByThisProcess()) return;
    const r = await rt.stop();
    if (!r.stopped) options.log?.(`stopping the app's own Ollama: ${r.reason}`);
  };

  return {
    status: () => inner.status(),
    baseUrl: () => (switching ? undefined : inner.baseUrl()),
    ensure: () => serial(() => inner.ensure()),
    discover: () => serial(() => inner.discover()),
    startedByThisProcess: () => inner.startedByThisProcess(),
    mode: () => mode,
    onChange(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    setMode(next) {
      return serial(async () => {
        if (next === mode) return inner.status();
        switching = true;
        try {
          await options.beforeSwitch?.();
          const old = inner;
          off();
          await stopIfStartedHere(old);
          mode = next;
          inner = options.make(next);
          off = inner.onChange(forward);
          const status = await inner.ensure();
          // A fresh runtime that lands on its initial status emits nothing itself.
          forward(status);
          return status;
        } finally {
          switching = false;
          options.afterSwitch?.();
        }
      });
    },
    stopIfStartedHere: () => serial(() => stopIfStartedHere(inner)),
  };
}
