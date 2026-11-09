import { execFile, execFileSync, spawn } from "node:child_process";

export interface ComfyService {
  inspect(): Promise<{ present: boolean; active: boolean; activeState: string; pid: number }>;
  start(): Promise<void>;
  stop(): Promise<void>;
  /** Deadline only: verify this run's MainPID, then queue a stop without waiting. */
  killRuntimeNow?(ownedPid: number): void;
}

export interface DeadlineSystemctl {
  read(args: readonly string[]): string;
  stop(args: readonly string[]): void;
}

const deadlineSystemctl: DeadlineSystemctl = {
  read: args => execFileSync("systemctl", [...args], { encoding: "utf8", timeout: 100, killSignal: "SIGKILL", stdio: ["ignore", "pipe", "ignore"] }),
  stop: args => {
    const child = spawn("systemctl", [...args], { detached: true, stdio: "ignore" });
    child.on("error", () => undefined);
    child.unref();
  },
};

export type Systemctl = (args: readonly string[]) => Promise<string>;
const run: Systemctl = (args) => new Promise((resolve, reject) => {
  execFile("systemctl", [...args], { timeout: 15_000 }, (error, stdout) => error ? reject(error) : resolve(stdout));
});

/** Only the named user unit. Callers must prove ownership and matching MainPID before stop. */
export function createComfyService(platform = process.platform, systemctl: Systemctl = run, deadline: DeadlineSystemctl = deadlineSystemctl): ComfyService {
  return {
    async inspect() {
      if (platform !== "linux") return { present: false, active: false, activeState: "unknown", pid: 0 };
      try {
        const text = await systemctl(["--user", "show", "comfyui.service", "--property=LoadState,ActiveState,MainPID"]);
        const fields = new Map(text.trim().split("\n").map((line) => {
          const index = line.indexOf("="); return [line.slice(0, index), line.slice(index + 1)];
        }));
        const activeState = fields.get("ActiveState") ?? "unknown";
        return { present: fields.get("LoadState") === "loaded", active: activeState === "active", activeState, pid: Number(fields.get("MainPID")) || 0 };
      } catch { return { present: false, active: false, activeState: "unknown", pid: 0 }; }
    },
    async start() {
      if (platform !== "linux") throw new Error("ComfyUI auto-start requires Linux; set a running ComfyUI address in Settings.");
      await systemctl(["--user", "start", "comfyui.service"]);
    },
    async stop() {
      if (platform !== "linux") return;
      await systemctl(["--user", "stop", "comfyui.service"]);
    },
    killRuntimeNow(ownedPid) {
      if (platform !== "linux") return;
      try {
        const current = deadline.read(["--user", "show", "comfyui.service", "--property=MainPID", "--value"]);
        if (Number(current.trim()) === ownedPid) deadline.stop(["--user", "stop", "--no-block", "comfyui.service"]);
      } catch { /* Missing, changed or unreadable units are left alone. */ }
    },
  };
}
