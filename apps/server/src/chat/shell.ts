import type { ShellStatus } from "@gates-local/contracts";
import type { SandboxProbe } from "../../../../packages/harness/src/sandbox/index.ts";

/**
 * Run commands, as Settings and the turn see it: ready only after the probe ran a command in the
 * sandbox. The probe's own detail (bwrap's or systemd's words) goes to the log once per change,
 * never to the screen.
 */
const NO_SQLITE = "Databases in your Library can't be read: this machine has no sqlite3 (/usr/bin/sqlite3).";

export function createShellStatus(probe: () => Promise<SandboxProbe>, log: (line: string) => void): () => Promise<ShellStatus> {
  let logged: string | undefined;
  return async () => {
    const result = await probe();
    // Without sqlite3 commands still run, so the tool stays on; the status says what cannot be done.
    const status: ShellStatus = !result.available ? { state: "off", word: result.word, reason: result.reason }
      : result.sqlite ? { state: "ready" } : { state: "ready", word: "Ready, without sqlite3", reason: NO_SQLITE };
    const line = result.available ? `shell sandbox: ready${result.sqlite ? "" : ", no /usr/bin/sqlite3 (database reads will fail)"}` : `shell sandbox: off, ${result.reason}${result.detail ? ` (${result.detail})` : ""}`;
    if (line !== logged) { logged = line; log(line); }
    return status;
  };
}
