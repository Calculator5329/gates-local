// Supervisor state types. Type-only, so the sandboxed preload can share them.

export type CrashReason =
  | { readonly kind: "exit"; readonly code: number | null; readonly signal: string | null }
  | { readonly kind: "ready-timeout"; readonly timeoutMs: number }
  | { readonly kind: "bad-ready"; readonly line: string }
  | { readonly kind: "spawn-error"; readonly message: string };

/**
 * idle -> starting -> ready -> crashed -> restarting -> ready ...
 * Any state -> stopping -> stopped on quit. Restart is only ever explicit.
 */
export type SupervisorState =
  | { readonly status: "idle" }
  | { readonly status: "starting"; readonly launch: number }
  | { readonly status: "restarting"; readonly launch: number }
  | {
      readonly status: "ready";
      readonly launch: number;
      readonly pid: number;
      readonly port: number;
      readonly url: string;
    }
  | {
      readonly status: "crashed";
      readonly launch: number;
      readonly pid: number | null;
      readonly reason: CrashReason;
      readonly stderrTail: readonly string[];
      readonly restartBlockedUntil: number | null;
    }
  | { readonly status: "stopping" }
  | { readonly status: "stopped" };
