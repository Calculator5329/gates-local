import type { ShellStatus } from "@gates-local/contracts";
import type { SandboxProbe } from "@gates-local/harness/sandbox";

const NO_SQLITE = "Databases in your Library can't be read: this machine has no sqlite3 (/usr/bin/sqlite3).";

export function createShellStatus(probe: () => Promise<SandboxProbe>, log: (line: string) => void): () => Promise<ShellStatus> {
  let logged: string | undefined;
  return async () => {
    const result = await probe();
    const status: ShellStatus = !result.available ? { state: "off", word: result.word, reason: result.reason }
      : result.sqlite ? { state: "ready" } : { state: "ready", word: "Ready, without sqlite3", reason: NO_SQLITE };
    const line = result.available ? `shell sandbox: ready${result.sqlite ? "" : ", no /usr/bin/sqlite3 (database reads will fail)"}` : `shell sandbox: off, ${result.reason}${result.detail ? ` (${result.detail})` : ""}`;
    if (line !== logged) { logged = line; log(line); }
    return status;
  };
}
