import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { MIB } from "./constants.ts";
import { cached, listeningInodes, processBasename, readGpuStatus, systemdMainPid, type GpuStatusDeps } from "./gpu-status.ts";

const fixture = (name: string) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8");
const MIXED = fixture("nvidia-smi-apps.mixed.txt");
const MACHINE = fixture("nvidia-smi-apps.machine.txt");
const MEMINFO = fixture("meminfo.machine.txt");

function smi(apps: string, totals = "NVIDIA GeForce RTX 5070 Ti, 16303, 15600, 703\n"): GpuStatusDeps["runNvidiaSmi"] {
  return async (args) => (args[0]?.startsWith("--query-gpu") ? totals : apps);
}

const linux = (over: Partial<GpuStatusDeps> = {}): GpuStatusDeps => ({
  platform: "linux",
  readMeminfo: async () => MEMINFO,
  now: () => 1000,
  ...over,
});

describe("gpu.status occupants", () => {
  it("names whisper, the chat model, ComfyUI, other apps and the unattributed rest", async () => {
    const s = await readGpuStatus(
      linux({
        runNvidiaSmi: smi(MIXED),
        residentModels: async () => [{ name: "qwen3.5:9b", sizeVramBytes: 5_920_000_000 }],
        listeningPids: async (port, pids) => new Set(port === 8188 ? pids.filter((p) => p === 5700) : []),
        modelLabel: (tag) => (tag === "qwen3.5:9b" ? "Qwen 3.5 9B" : tag),
        mayUnload: () => ["qwen3.5:9b"],
      }),
    );
    expect(s).toMatchObject({ vendor: "nvidia", name: "RTX 5070 Ti", totalBytes: 16303 * MIB, freeBytes: 703 * MIB, measuredAt: 1000 });
    expect(s.systemMemoryAvailableBytes).toBe(14822112 * 1024);
    const byLabel = Object.fromEntries(s.occupants.map((o) => [o.label, o]));
    expect(byLabel["Whisper"]).toEqual({ label: "Whisper", bytes: 2202 * MIB, kind: "whisper", protected: true });
    // The runner's nvidia-smi bytes, larger than /api/ps size_vram, label the model.
    expect(byLabel["Qwen 3.5 9B"]).toEqual({ label: "Qwen 3.5 9B", bytes: 6926 * MIB, kind: "chat-model", protected: false });
    expect(byLabel["ComfyUI"]).toEqual({ label: "ComfyUI", bytes: 3110 * MIB, kind: "image", protected: false });
    expect(byLabel["Media Vault vision"]).toMatchObject({ kind: "other-app", protected: true, bytes: 1822 * MIB });
    expect(byLabel["browser"]).toMatchObject({ kind: "other-app", protected: true, bytes: 121 * MIB });
    // Two viewer processes become one row.
    expect(byLabel["viewer"]).toMatchObject({ kind: "other-app", bytes: 174 * MIB });
    expect(byLabel["Not attributed to a process"]).toMatchObject({ kind: "unknown", bytes: (15600 - 14472) * MIB });
    // Largest first.
    expect(s.occupants.map((o) => o.bytes)).toEqual(s.occupants.map((o) => o.bytes).toSorted((a, b) => b - a));
  });

  it("a python not listening on 8188 is another app; a model the app did not load stays protected", async () => {
    const s = await readGpuStatus(
      linux({ runNvidiaSmi: smi(MIXED), residentModels: async () => [{ name: "gemma4:12b", sizeVramBytes: 1 }], listeningPids: async () => new Set() }),
    );
    expect(s.occupants.find((o) => o.kind === "image")).toBeUndefined();
    expect(s.occupants.find((o) => o.label === "python")).toMatchObject({ kind: "other-app", bytes: 3110 * MIB });
    expect(s.occupants.find((o) => o.kind === "chat-model")).toMatchObject({ label: "gemma4:12b", protected: true });
  });

  it("the ComfyUI the app runs is ComfyUI by its pid, on whatever port it listens", async () => {
    const s = await readGpuStatus(linux({ runNvidiaSmi: smi(MIXED), listeningPids: async () => new Set(), imagePid: () => 5700 }));
    expect(s.occupants.find((o) => o.kind === "image")).toEqual({ label: "ComfyUI", bytes: 3110 * MIB, kind: "image", protected: false });
  });

  it("whisper is matched by the service MainPID when its process name does not say whisper", async () => {
    const apps = "9001, /usr/bin/python3, 2100\n";
    const s = await readGpuStatus(linux({ runNvidiaSmi: smi(apps, "RTX, 16303, 2100, 14000"), whisperPid: async () => 9001 }));
    expect(s.occupants).toEqual([{ label: "Whisper", bytes: 2100 * MIB, kind: "whisper", protected: true }]);
  });

  it("two resident models split the runners' bytes by their size_vram", async () => {
    const apps = "1, /usr/bin/ollama, 3000\n2, /usr/bin/ollama, 1000\n";
    const s = await readGpuStatus(
      linux({ runNvidiaSmi: smi(apps, "RTX, 16303, 4000, 12000"), residentModels: async () => [{ name: "a:1b", sizeVramBytes: 3 }, { name: "b:1b", sizeVramBytes: 1 }] }),
    );
    expect(s.occupants).toEqual([
      { label: "a:1b", bytes: 3000 * MIB, kind: "chat-model", protected: true },
      { label: "b:1b", bytes: 1000 * MIB, kind: "chat-model", protected: true },
    ]);
  });

  it("a chat model is unprotected exactly when an image job may unload it: in the fed list, or every one in an Ollama the app started", async () => {
    const apps = "1, /usr/bin/ollama, 3000\n2, /usr/bin/ollama, 1000\n";
    const read = (over: Partial<GpuStatusDeps>) => readGpuStatus(
      linux({ runNvidiaSmi: smi(apps, "RTX, 16303, 4000, 12000"), residentModels: async () => [{ name: "warm:9b", sizeVramBytes: 3 }, { name: "other:4b", sizeVramBytes: 1 }], ...over }),
    );
    const guarded = async (over: Partial<GpuStatusDeps>) => Object.fromEntries((await read(over)).occupants.map((o) => [o.label, o.protected]));
    expect(await guarded({ mayUnload: () => ["warm:9b"] }), "the fed list: a warm model a turn answered on").toEqual({ "warm:9b": false, "other:4b": true });
    expect(await guarded({ mayUnload: () => [], ownsRuntime: () => true }), "the app's own Ollama: every resident model").toEqual({ "warm:9b": false, "other:4b": false });
    expect(await guarded({ mayUnload: () => [], ownsRuntime: () => false }), "an Ollama the app did not start: only the list").toEqual({ "warm:9b": true, "other:4b": true });
  });

  it("the machine fixture: whisper and Media Vault are protected, the desktop is named", async () => {
    const s = await readGpuStatus(linux({ runNvidiaSmi: smi(MACHINE, "NVIDIA GeForce RTX 5070 Ti, 16303, 6458, 9468") }));
    expect(s.occupants.filter((o) => o.protected).length).toBe(s.occupants.length);
    expect(s.occupants.map((o) => o.label)).toEqual(expect.arrayContaining(["Whisper", "Media Vault vision", "Desktop (KWin)", "viewer", "chat-app", "editor"]));
  });
});

describe("gpu.status without a readable NVIDIA GPU", () => {
  const enoent = Object.assign(new Error("spawn nvidia-smi ENOENT"), { code: "ENOENT" });

  it("Windows with no nvidia-smi: vendor none, system memory from os.freemem, no /proc", async () => {
    const s = await readGpuStatus({
      platform: "win32",
      runNvidiaSmi: async () => Promise.reject(enoent),
      readMeminfo: async () => {
        throw new Error("must not read /proc on Windows");
      },
      whisperPid: async () => {
        throw new Error("must not call systemctl on Windows");
      },
      freemem: () => 9_000_000_000,
      now: () => 5,
    });
    expect(s).toEqual({
      vendor: "none",
      occupants: [],
      systemMemoryAvailableBytes: 9_000_000_000,
      measuredAt: 5,
    });
  });

  it("a driver that cannot communicate leaves no usable NVIDIA GPU", async () => {
    const s = await readGpuStatus(linux({ runNvidiaSmi: async () => Promise.reject(new Error("NVIDIA-SMI has failed because it couldn't communicate with the NVIDIA driver")) }));
    expect(s.vendor).toBe("none");
    expect(s.detail).toContain("couldn't communicate");
  });

  it("nvidia-smi with no devices is vendor none", async () => {
    const s = await readGpuStatus(linux({ runNvidiaSmi: async () => Promise.reject(Object.assign(new Error("Command failed"), { stdout: "No devices were found\n" })) }));
    expect(s.vendor).toBe("none");
  });
});

describe("readers", () => {
  it("processBasename handles Linux paths with flags and Windows paths", () => {
    expect(processBasename("/app/extra/chrome --type=gpu-process --x")).toBe("chrome");
    expect(processBasename("C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe")).toBe("chrome");
    expect(processBasename("falkon")).toBe("falkon");
  });

  it("listeningInodes picks LISTEN rows on the port from tcp and tcp6", () => {
    const tcp = [
      "  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode",
      "   0: 0100007F:1FFC 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 555 1 0000000000000000 100 0 0 10 0",
      "   1: 0100007F:1FFC 0100007F:D2A4 01 00000000:00000000 00:00000000 00000000  1000        0 556 1 0000000000000000 20 4 30 10 -1",
      "   2: 0100007F:2CAA 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 557 1 0000000000000000 100 0 0 10 0",
    ].join("\n");
    const tcp6 = ["  sl  local_address remote_address st tx rx tr tm retr uid timeout inode", "   0: 00000000000000000000000001000000:1FFC 00000000000000000000000000000000:0000 0A 00000000:00000000 00:00000000 00000000  1000 0 777 1"].join("\n");
    expect(listeningInodes([tcp, tcp6], 8188)).toEqual(new Set(["555", "777"]));
  });

  it("systemdMainPid reads the pid and treats 0 as not running", async () => {
    const calls: string[] = [];
    const run = (out: string) => async (cmd: string, args: readonly string[]) => {
      calls.push([cmd, ...args].join(" "));
      return out;
    };
    expect(await systemdMainPid("whisper-server.service", run("5100\n"))).toBe(5100);
    expect(await systemdMainPid("whisper-server.service", run("0\n"))).toBeUndefined();
    expect(calls[0]).toBe("systemctl --user show -p MainPID --value whisper-server.service");
  });

  it("cached reuses a read within its ttl", async () => {
    let t = 0;
    let reads = 0;
    const read = cached(async () => ++reads, 1000, () => t);
    expect([await read(), await read()]).toEqual([1, 1]);
    t = 1000;
    expect(await read()).toBe(2);
  });
});
