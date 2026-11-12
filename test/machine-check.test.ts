// The setup recommendation from injected readings, and the agent runbook's
// commands. Nothing here touches the real GPU or Ollama.
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { NvidiaSmiRunner } from "../apps/server/src/fit/types.ts";
import { advise, formatReport, type GpuReading, type MachineReadings, readGpuReading } from "../scripts/machine-advice.ts";

const GIB = 1024 ** 3;
const CHECKPOINT = "sdxl_lightning_4step.safetensors";
const LORA = "RW_pixelart_XL_v1.safetensors";
const root = path.resolve(import.meta.dirname, "..");

const machine = (gpu: GpuReading, ramAvailable = 16 * GIB, diskFree = 200 * GIB): MachineReadings => ({
  os: "Linux 6.1 x64",
  gpu,
  ramTotalBytes: ramAvailable + 4 * GIB,
  ramAvailableBytes: ramAvailable,
  diskFreeBytes: diskFree,
  measuredAt: 1,
});
const nvidia = (total: number, free = total): GpuReading => ({ kind: "nvidia", name: "Example GPU", totalBytes: total * GIB, freeBytes: free * GIB });

describe("what the machine check recommends", () => {
  it("no GPU: the lightest text model in system memory, and skip images because there is no GPU", () => {
    const { text, image } = advise(machine({ kind: "none" }));
    expect(text).toMatchObject({ use: true, model: "qwen3.5:4b", verdict: "spills" });
    expect(image.use).toBe(false);
    expect(image).toMatchObject({ why: expect.stringContaining("no GPU") });
  });

  it("a small GPU: the text model that fits it, and skip images because 9 GB will not fit", () => {
    const { text, image } = advise(machine(nvidia(6)));
    expect(text).toMatchObject({ use: true, model: "qwen3.5:4b", verdict: "fits" });
    expect(image.use).toBe(false);
    expect(image).toMatchObject({ why: expect.stringMatching(/6\.0 GB.*9\.0 GB/) });
  });

  it("a large GPU: the app's first recommended model, the others it recommends, and images on", () => {
    const { text, image } = advise(machine(nvidia(24)));
    expect(text).toMatchObject({ use: true, model: "qwen3.5:9b", verdict: "fits" });
    if (!text.use) throw new Error("expected a text model");
    expect(text.alsoRecommended).toContain("gemma4:12b");
    expect(text.alsoRecommended).not.toContain("qwen3.5:9b");
    expect(image).toEqual({ use: true, checkpoint: CHECKPOINT, lora: LORA });
  });

  it("a large GPU that is busy right now keeps images on and says memory is short at the moment", () => {
    const { text, image } = advise(machine(nvidia(16, 4)));
    expect(text).toMatchObject({ use: true, model: "qwen3.5:4b", verdict: "spills" });
    expect(image).toMatchObject({ use: true, note: expect.stringContaining("4.0 GB free") });
  });

  it("too little memory for any model says so and names the lightest", () => {
    const { text } = advise(machine({ kind: "none" }, 3 * GIB));
    expect(text.use).toBe(false);
    expect(text).toMatchObject({ why: expect.stringContaining("qwen3.5:4b") });
  });

  it("an nvidia-smi that fails: images skipped for that reason, text planned without the GPU, and a warning", async () => {
    const gpu = await readGpuReading(broken);
    if (gpu.kind !== "unreadable") throw new Error("expected an unreadable GPU");
    const readings = machine(gpu);
    const advice = advise(readings);
    const { text, image, warnings } = advice;
    expect(text).toMatchObject({ use: true, model: "qwen3.5:4b" });
    expect.soft(image).toEqual({ use: false, why: gpu.reason });
    expect.soft(warnings[0]).toBe(`${gpu.reason} The app will not start a chat until this is fixed, so the text pick below plans as if there were no GPU.`);
    expect.soft(formatReport(readings, advice)).not.toContain("Could not be read:");
  });

  it("warns when the recommended text download is larger than the free disk", () => {
    expect(advise(machine(nvidia(24), 16 * GIB, 1 * GIB)).warnings.join(" ")).toContain("1.0 GB free");
    expect(advise(machine(nvidia(24), 16 * GIB, 200 * GIB)).warnings).toEqual([]);
  });

  it("the report names every reading and both recommendations", () => {
    const m = machine(nvidia(24, 20));
    const report = formatReport(m, advise(m));
    for (const expected of ["Linux 6.1 x64", "Example GPU", "24.0 GB", "20.0 GB", "Free disk", "qwen3.5:9b", CHECKPOINT, LORA]) expect(report).toContain(expected);
    const none = machine({ kind: "none" });
    expect(formatReport(none, advise(none))).toMatch(/Skip/);
  });
});

const smi = (name: string, totals: string): NvidiaSmiRunner => async (args) => (args[0] === "--query-gpu=name" ? name : args[0]?.includes("memory") ? totals : "");
const broken: NvidiaSmiRunner = async () => {
  throw new Error("driver mismatch");
};

describe("reading the GPU", () => {
  it("reads the name and memory from nvidia-smi", async () => {
    await expect(readGpuReading(smi("Example GPU\n", "16376, 1000, 15376\n"))).resolves.toEqual({
      kind: "nvidia",
      name: "Example GPU",
      totalBytes: 16376 * 1024 ** 2,
      freeBytes: 15376 * 1024 ** 2,
    });
  });

  it.each([
    Object.assign(new Error("spawn nvidia-smi ENOENT"), { code: "ENOENT" }),
    new Error("No devices were found"),
    new Error("NVIDIA-SMI has failed because it couldn't communicate with the NVIDIA driver. Make sure that the latest NVIDIA driver is installed and running. This can also be happening if non-NVIDIA GPU is running as primary display, and NVIDIA GPU is in WDDM mode."),
  ])("missing NVIDIA software or confirmed absence means no GPU the app can read: %s", async (error) => {
    const run: NvidiaSmiRunner = async () => { throw error; };
    await expect(readGpuReading(run)).resolves.toEqual({ kind: "none" });
  });

  it("an nvidia-smi that fails is unreadable, not no GPU", async () => {
    await expect(readGpuReading(broken)).resolves.toMatchObject({ kind: "unreadable", reason: expect.stringContaining("driver mismatch") });
  });
});

// `pnpm install` is pnpm's own command; every other name must be a script here.
const PNPM_BUILTINS = new Set(["install"]);

/** The scripts named by `pnpm <name>` or `pnpm run <name>` inside code spans and fenced blocks. */
function pnpmScriptsNamed(markdown: string): string[] {
  const code = [...markdown.matchAll(/```[\s\S]*?```|`[^`\n]+`/g)].map((m) => m[0].replaceAll("`", ""));
  const names = code.flatMap((c) => [...c.matchAll(/(?:^|[\s;&|(])pnpm\s+(?:run\s+)?([a-z][\w:-]*)/gm)].map((m) => m[1] as string));
  return [...new Set(names)].filter((n) => !PNPM_BUILTINS.has(n));
}

const runbook = () => readFileSync(path.join(root, "docs/setup/with-claude-code.md"), "utf8");
const scripts = () => Object.keys((JSON.parse(readFileSync(path.join(root, "package.json"), "utf8")) as { scripts: Record<string, string> }).scripts);

describe("the agent runbook", () => {
  it("the check finds scripts in code only, and leaves pnpm's own commands out", () => {
    expect(pnpmScriptsNamed("Run `pnpm nope --x` and\n```sh\npnpm install\npnpm run other\n```\nif pnpm start is prose")).toEqual(["nope", "other"]);
  });

  it("names only pnpm scripts that exist", () => {
    const named = pnpmScriptsNamed(runbook());
    expect(named).toEqual(expect.arrayContaining(["machine-check", "start"]));
    expect(named.filter((n) => !scripts().includes(n))).toEqual([]);
  });
});
