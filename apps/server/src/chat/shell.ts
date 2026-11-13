import type { ShellStatus } from "@gates-local/contracts";
import type { SandboxProbe } from "../../../../packages/harness/src/sandbox/index.ts";

/**
 * Run commands, as Settings and the turn see it: ready only after the probe ran a command in the
 * sandbox. The probe's own detail (bwrap's or systemd's words) goes to the log once per change,
 * never to the screen.
 */
export function createShellStatus(probe: () => Promise<SandboxProbe>, log: (line: string) => void): () => Promise<ShellStatus> {
  let logged: string | undefined;
  return async () => {
    const result = await probe();
    const status: ShellStatus = result.available ? { state: "ready" } : { state: "off", word: result.word, reason: result.reason };
    const line = result.available ? "shell sandbox: ready" : `shell sandbox: off, ${result.reason}${result.detail ? ` (${result.detail})` : ""}`;
    if (line !== logged) { logged = line; log(line); }
    return status;
  };
}
