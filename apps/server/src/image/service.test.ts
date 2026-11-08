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
  expect(systemctl).not.toHaveBeenCalled();
});
