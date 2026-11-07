import { execFile } from "node:child_process";

export interface ComfyService {
  inspect(): Promise<{ present: boolean; active: boolean; pid: number }>;
  start(): Promise<void>;
  stop(): Promise<void>;
}

export type Systemctl = (args: readonly string[]) => Promise<string>;
const run: Systemctl = (args) => new Promise((resolve, reject) => {
  execFile("systemctl", [...args], { timeout: 15_000 }, (error, stdout) => error ? reject(error) : resolve(stdout));
});

/** Only the named user unit. Callers must prove ownership and matching MainPID before stop. */
export function createComfyService(platform = process.platform, systemctl: Systemctl = run): ComfyService {
  return {
    async inspect() {
      if (platform !== "linux") return { present: false, active: false, pid: 0 };
      try {
        const text = await systemctl(["--user", "show", "comfyui.service", "--property=LoadState,ActiveState,MainPID"]);
        const fields = new Map(text.trim().split("\n").map((line) => {
          const index = line.indexOf("="); return [line.slice(0, index), line.slice(index + 1)];
        }));
        return { present: fields.get("LoadState") === "loaded", active: fields.get("ActiveState") === "active", pid: Number(fields.get("MainPID")) || 0 };
      } catch { return { present: false, active: false, pid: 0 }; }
    },
    async start() {
      if (platform !== "linux") throw new Error("ComfyUI auto-start requires Linux; set a running ComfyUI address in Settings.");
      await systemctl(["--user", "start", "comfyui.service"]);
    },
    async stop() {
      if (platform !== "linux") return;
      await systemctl(["--user", "stop", "comfyui.service"]);
    },
  };
}
