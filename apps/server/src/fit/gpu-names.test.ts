// Who holds GPU memory, by name: docs/evidence/windows-low-memory-bug-report.md, entry WIN-MEM-05.
// On Windows nvidia-smi prints full paths with spaces, a bracketed note where a name should be,
// and [N/A] for every process's memory. A refusal there listed "[Insufficient (unknown)" and
// "C:\Program (unknown)".
import { describe, expect, it } from "vitest";
import { MIB } from "./constants.ts";
import { holdersSummary, parseComputeApps, processBasename } from "./gpu.ts";
import { readGpuStatus } from "./gpu-status.ts";
import { fitSentence } from "../image/module.ts";

const WINDOWS_APPS = [
  "4321, [Insufficient Permissions], [N/A]",
  "812, C:\\Windows\\System32\\dwm.exe, [N/A]",
  "6120, C:\\Windows\\SystemApps\\ShellExperienceHost_cw5n1h2txyewy\\ShellExperienceHost.exe, [N/A]",
  "9044, C:\\Users\\someone\\AppData\\Local\\Discord\\app-1.0.9\\Discord.exe, [N/A]",
  "7788, C:\\Program Files\\Some App\\Some App.exe, [N/A]",
  "3020, F:\\ComfyUI_windows_portable\\python_embeded\\python.exe, [N/A]",
  "5512, C:\\Users\\someone\\AppData\\Local\\Programs\\Ollama\\ollama.exe, [N/A]",
].join("\r\n");

const gib = (bytes: number) => `${(bytes / 1024 ** 3).toFixed(1)} GiB`;

describe("GPU holder names (WIN-MEM-05)", () => {
  it("a Windows path with spaces is named by its program, never cut at a space or shown whole", () => {
    const tenants = parseComputeApps(WINDOWS_APPS);
    expect(tenants).toHaveLength(7);
    const label = (pid: number) => tenants.find((t) => t.pid === pid)?.label;
    expect(label(7788)).toBe("Some App");
    expect(label(9044)).toBe("Discord");
    expect(label(3020)).toBe("python");
    for (const t of tenants) expect(t.label, t.processName).not.toMatch(/[\\/:[\]]|\.exe$/i);
  });

  it("a bracketed note in place of a name is a process without a name, not a name", () => {
    const tenants = parseComputeApps(WINDOWS_APPS);
    expect(tenants.find((t) => t.pid === 4321)).toMatchObject({ unnamed: true, role: "occupant" });
    expect(tenants.filter((t) => t.unnamed === true)).toHaveLength(1);
    for (const note of ["[N/A]", "[Not Found]", "[Unknown Error]", "[Not Supported]"]) {
      expect(parseComputeApps(`9, ${note}, 300`)[0], note).toMatchObject({ unnamed: true, usedBytes: 300 * MIB });
    }
  });

  it("the desktop's own processes are marked as the system's, on Windows and on Linux", () => {
    const tenants = parseComputeApps(`${WINDOWS_APPS}\r\n1200, /usr/bin/kwin_wayland, 116`);
    const system = tenants.filter((t) => t.system === true).map((t) => t.pid);
    expect(system.toSorted((a, b) => a - b)).toEqual([812, 1200, 6120]);
    expect(tenants.find((t) => t.pid === 812)?.label).toBe("Windows desktop");
    expect(tenants.find((t) => t.pid === 6120)?.label).toBe("Windows desktop");
  });

  it("Ollama on Windows is still the chat runtime", () => {
    expect(parseComputeApps(WINDOWS_APPS).find((t) => t.pid === 5512)).toMatchObject({ role: "ollama", label: "ollama" });
  });

  it("Linux names keep their meaning: a command with flags, whisper, a bare name", () => {
    expect(processBasename("/app/extra/chrome --type=gpu-process --x")).toBe("chrome");
    expect(processBasename("C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe")).toBe("chrome");
    expect(processBasename("falkon")).toBe("falkon");
    const tenants = parseComputeApps(["5100, /usr/bin/whisper-server, 2202", "5200, viewer, 63", "77, /opt/app --flag=a,b,c, 300"].join("\n"));
    expect(tenants.map((t) => [t.label, t.role])).toEqual([["whisper-server", "whisper"], ["viewer", "occupant"], ["app", "occupant"]]);
  });

  describe("the one line a refusal carries", () => {
    it("with no per-process reading it says so once and lists no names or made-up sizes", () => {
      const line = holdersSummary(parseComputeApps(WINDOWS_APPS), gib);
      expect(line).toBe("7 processes, GPU memory not reported per process");
      expect(line).not.toMatch(/unknown|\\|\[/);
    });

    it("measured holders are ranked by GPU memory, the rest are counted", () => {
      const tenants = parseComputeApps([
        "1, /usr/bin/small, 512",
        "2, /usr/bin/big, 4096",
        "3, viewer, 1024",
        "4, viewer, 1024",
        "5, [Insufficient Permissions], [N/A]",
        "6, /usr/bin/quiet, [N/A]",
      ].join("\n"));
      expect(holdersSummary(tenants, gib)).toBe("big 4.0 GiB, viewer 2.0 GiB, small 0.5 GiB, 2 more not reported");
    });

    it("lists at most four names", () => {
      const tenants = parseComputeApps(["1, a, 600", "2, b, 500", "3, c, 400", "4, d, 300", "5, e, 200", "6, f, 100"].join("\n"));
      expect(holdersSummary(tenants, gib)).toBe("a 0.6 GiB, b 0.5 GiB, c 0.4 GiB, d 0.3 GiB, 2 more 0.3 GiB");
    });

    it("says when nothing is listed", () => {
      expect(holdersSummary([], gib)).toBe("no process listed");
    });
  });

  it("an image refusal never tells a person to close the desktop or a process it cannot name", () => {
    const tenants = parseComputeApps(["812, C:\\Windows\\System32\\dwm.exe, 3000", "4321, [Insufficient Permissions], 2000", "9044, C:\\Apps\\Discord.exe, 400"].join("\r\n"));
    expect(fitSentence(4 * 1024 ** 3, 1024 ** 3, tenants, [])).toBe("The image needs 4.0 GiB and 1.0 GiB is free; Discord holds 0.4 GiB, close it.");
    expect(fitSentence(4 * 1024 ** 3, 1024 ** 3, tenants.slice(0, 2), [])).toBe("The image needs 4.0 GiB and 1.0 GiB is free.");
  });

  it("the memory bar gets no 0 GB rows: what Windows does not attribute is one measured remainder", async () => {
    const status = await readGpuStatus({
      platform: "win32",
      freemem: () => 4 * 1024 ** 3,
      now: () => 1,
      // GTX 1660 Ti, 6,144 MiB with 5,481 used and 486 free: the report's reading
      runNvidiaSmi: async (args) => args.some((a) => a.startsWith("--query-gpu")) ? "NVIDIA GeForce GTX 1660 Ti, 6144, 5481, 486\r\n" : WINDOWS_APPS,
    });
    expect(status.vendor).toBe("nvidia");
    expect(status.occupants).toEqual([{ label: "Not attributed to a process", bytes: 5481 * MIB, kind: "unknown", protected: true }]);
  });
});
