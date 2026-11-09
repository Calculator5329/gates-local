import { expect, it, vi } from "vitest";
import { createComfyService } from "./service.ts";

it.each(["inactive", "failed", "active", "activating", "deactivating", "reloading"])("preserves the raw unit ActiveState %s", async (activeState) => {
  const systemctl = vi.fn(async () => `LoadState=loaded\nActiveState=${activeState}\nMainPID=42\n`);
  expect(await createComfyService("linux", systemctl).inspect()).toEqual({ present: true, active: activeState === "active", activeState, pid: 42 });
});

it("never invokes systemctl on Windows", async () => {
  const systemctl = vi.fn(); const service = createComfyService("win32", systemctl);
  expect(await service.inspect()).toMatchObject({ present: false, active: false, pid: 0 });
  await expect(service.start()).rejects.toThrow(/Linux/); await service.stop();
  service.killRuntimeNow?.(42);
  expect(systemctl).not.toHaveBeenCalled();
});

it.each(["42", "99", "0", "not-a-pid", "failed"])("SN-CO-06 the deadline stop verifies MainPID before queuing a nonblocking unit stop (%s)", pid => {
  const read = vi.fn(() => { if (pid === "failed") throw new Error("Timed out"); return pid; });
  const stop = vi.fn();
  const service = createComfyService("linux", vi.fn(async () => ""), { read, stop });
  service.killRuntimeNow?.(42);
  expect(read).toHaveBeenCalledExactlyOnceWith(["--user", "show", "comfyui.service", "--property=MainPID", "--value"]);
  if (pid === "42") expect(stop).toHaveBeenCalledExactlyOnceWith(["--user", "stop", "--no-block", "comfyui.service"]);
  else expect(stop).not.toHaveBeenCalled();
});
