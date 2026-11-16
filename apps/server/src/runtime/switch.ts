import type { RuntimeMode, RuntimeStatus } from "@gates-local/contracts";
import type { OllamaRuntime } from "./runtime.ts";
import type { Listener } from "./types.ts";

export interface RuntimeSwitch extends Pick<OllamaRuntime, "status" | "baseUrl" | "onChange" | "ensure" | "discover" | "startedByThisProcess" | "killNow"> {
  mode(): RuntimeMode;
  setMode(mode: RuntimeMode): Promise<RuntimeStatus>;
  stopIfStartedHere(): Promise<void>;
  lookIfDown(): Promise<RuntimeStatus>;
}

export interface RuntimeSwitchOptions {
  readonly initialMode: RuntimeMode;
  readonly make: (mode: RuntimeMode) => OllamaRuntime;
  readonly beforeSwitch?: () => void | Promise<void>;
  readonly afterSwitch?: () => void;
  readonly log?: (line: string) => void;
  readonly faultForTest?: "stop-any-runtime";
}

export function createRuntimeSwitch(options: RuntimeSwitchOptions): RuntimeSwitch {
  const listeners = new Set<Listener<RuntimeStatus>>();
  let mode = options.initialMode;
  let inner = options.make(mode);
  let lastSent: string | undefined;
  const send = (s: RuntimeStatus) => {
    const key = JSON.stringify(s);
    if (key === lastSent) return;
    lastSent = key;
    for (const l of listeners) l(s);
  };
  let switching = false;
  let refused: RuntimeStatus | undefined;
  const forward = (s: RuntimeStatus) => {
    refused = undefined;
    if (switching && s.state === "ready") return;
    send(s);
  };
  let off = inner.onChange(forward);
  let chain: Promise<unknown> = Promise.resolve();
  let looking: Promise<RuntimeStatus> | undefined;
  const serial = <T>(fn: () => Promise<T>): Promise<T> => {
    const run = chain.then(fn);
    chain = run.catch(() => undefined);
    return run;
  };

  const stopIfStartedHere = async (rt: OllamaRuntime) => {
    if (!rt.startedByThisProcess() && options.faultForTest !== "stop-any-runtime") return;
    const r = await rt.stop();
    if (!r.stopped) options.log?.(`stopping the app's own Ollama: ${r.reason}`);
  };

  return {
    status: () => refused ?? inner.status(),
    baseUrl: () => (switching ? undefined : inner.baseUrl()),
    ensure: () =>
      serial(async () => {
        const s = await inner.ensure();
        if (refused === undefined) return s;
        refused = undefined;
        send(inner.status());
        return inner.status();
      }),
    discover: () => serial(() => inner.discover()),
    startedByThisProcess: () => inner.startedByThisProcess(),
    killNow: () => inner.killNow(),
    mode: () => mode,
    onChange(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    setMode(next) {
      return serial(async () => {
        if (next === mode) return inner.status();
        switching = true;
        refused = undefined;
        try {
          try {
            await options.beforeSwitch?.();
          } catch (e) {
            refused = { ...inner.status(), state: "error", detail: `Switching to the ${next} runtime failed: ${(e as Error).message}. Still on the ${mode} runtime.` };
            throw e;
          }
          const old = inner;
          off();
          await stopIfStartedHere(old);
          mode = next;
          inner = options.make(next);
          off = inner.onChange(forward);
          return await inner.ensure();
        } finally {
          switching = false;
          options.afterSwitch?.();
          send(refused ?? inner.status());
        }
      });
    },
    stopIfStartedHere: () => serial(() => stopIfStartedHere(inner)),
    lookIfDown() {
      looking ??= serial(async () => {
        const now = refused ?? inner.status();
        if (now.state !== "ready" && now.state !== "error") await inner.discover();
        return refused ?? inner.status();
      }).finally(() => {
        looking = undefined;
      });
      return looking;
    },
  };
}
