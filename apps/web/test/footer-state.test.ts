// The sidebar footer's Settings and Models icons: what each says and shows,
// from the runtime row's words and the store's model downloads.
import { describe, expect, it } from "vitest";
import type { PullProgress } from "@gates-local/contracts";
import { finishedInBurst, modelsIcon, settingsIcon } from "../src/footer-state.ts";

const GIB = 1024 ** 3;
const name = (tag: string) => ({ "qwen3:14b": "Qwen 3 14B", "gemma4:12b": "Gemma 4 12B" })[tag] ?? tag;
const pull = (o: Partial<PullProgress> & Pick<PullProgress, "name" | "state">): PullProgress => ({ completedBytes: 0, ...o });

describe("Settings", () => {
  it("a ready runtime: the gear alone, the shortcut in its tooltip", () => {
    expect(settingsIcon(null)).toEqual({ dot: null, tip: "Settings · Ctrl ,", label: "Settings", runtime: false });
  });
  it("a runtime that needs the person: an amber dot, the row's words first and its tooltip kept, and the click goes to Runtime", () => {
    const i = settingsIcon({ text: "Reconnecting", tip: "The Gates Local server stopped answering. Trying again.", dot: "run" });
    expect(i).toMatchObject({ dot: "amber", runtime: true, label: "Settings · Reconnecting" });
    expect(i.tip).toBe("<b>Reconnecting</b><br>The Gates Local server stopped answering. Trying again.<br>Settings · Ctrl ,");
    expect(settingsIcon({ text: "Ollama stopped", tip: "x", dot: "warn" }).dot).toBe("amber");
  });
  it("where the row's dot was red, the gear's dot is red", () => {
    expect(settingsIcon({ text: "Port 11434 · busy", tip: "Something other than Ollama answers on port 11434.", dot: "err" })).toMatchObject({ dot: "red", label: "Settings · Port 11434 · busy" });
  });
  it("escapes the row's words", () => {
    expect(settingsIcon({ text: "<x>", tip: "t", dot: "err" }).tip).toContain("<b>&lt;x&gt;</b>");
  });
});

describe("Models", () => {
  it("nothing happening: the chip and its name", () => {
    expect(modelsIcon([], name)).toEqual({ state: "idle", progress: null, failed: false, tip: "Models", label: "Models" });
  });
  it("one download: the ring and a tooltip that names the model", () => {
    const i = modelsIcon([pull({ name: "qwen3:14b", state: "downloading", completedBytes: 5.7 * GIB, totalBytes: 9.3 * GIB })], name);
    expect(i.state).toBe("downloading");
    expect(i.progress).toBeCloseTo(5.7 / 9.3);
    expect(i.tip).toBe("<b>Downloading Qwen 3 14B</b> · 61% · 5.7 of 9.3 GB");
    expect(i.label).toBe("Models · Downloading Qwen 3 14B · 61% · 5.7 of 9.3 GB");
  });
  it("several at once: the ring shows the total and each has its own line", () => {
    const i = modelsIcon([
      pull({ name: "qwen3:14b", state: "downloading", completedBytes: 1 * GIB, totalBytes: 9 * GIB }),
      pull({ name: "gemma4:12b", state: "downloading", completedBytes: 3 * GIB, totalBytes: 7 * GIB }),
    ], name);
    expect(i.progress).toBeCloseTo(4 / 16);
    expect(i.tip.split("<br>")).toHaveLength(2);
    expect(i.tip).toContain("Qwen 3 14B");
    expect(i.tip).toContain("Gemma 4 12B");
  });
  it("queued, starting and verifying have honest words; no size yet is a turning ring", () => {
    expect(modelsIcon([pull({ name: "qwen3:14b", state: "queued" })], name)).toMatchObject({ state: "downloading", progress: null, tip: "<b>Qwen 3 14B</b> is waiting to download" });
    expect(modelsIcon([pull({ name: "qwen3:14b", state: "downloading" })], name).tip).toBe("<b>Starting the download of Qwen 3 14B</b>");
    expect(modelsIcon([pull({ name: "qwen3:14b", state: "verifying", completedBytes: 9, totalBytes: 9 })], name)).toMatchObject({ progress: 1, tip: "<b>Checking Qwen 3 14B</b> after downloading it" });
  });
  it("a failed download: red with a dot, which model and why", () => {
    const i = modelsIcon([pull({ name: "qwen3:14b", state: "error", message: "pull model manifest: <file does not exist>" })], name);
    expect(i).toMatchObject({ state: "failed", failed: true, progress: null });
    expect(i.tip).toBe("<b>Qwen 3 14B did not finish downloading.</b> pull model manifest: &lt;file does not exist&gt;");
  });
  it("a failure beside a running download keeps the ring and adds the dot and its line", () => {
    const i = modelsIcon([
      pull({ name: "qwen3:14b", state: "error" }),
      pull({ name: "gemma4:12b", state: "downloading", completedBytes: 1, totalBytes: 2 }),
    ], name);
    expect(i).toMatchObject({ state: "downloading", failed: true, progress: 0.5 });
    expect(i.tip.split("<br>")).toHaveLength(2);
  });
  it("the ring never goes backwards in one burst: a download that finished stays in the total until none runs", () => {
    const a = pull({ name: "qwen3:14b", state: "downloading", completedBytes: 8 * GIB, totalBytes: 9 * GIB });
    const b = pull({ name: "gemma4:12b", state: "downloading", completedBytes: 1 * GIB, totalBytes: 7 * GIB });
    let kept = finishedInBurst([], [a, b]);
    const before = modelsIcon([a, b], name, kept).progress ?? 0;
    // a finishes, then settles out of the store when the model list refreshes
    const aDone = { ...a, state: "done" as const, completedBytes: 9 * GIB };
    kept = finishedInBurst(kept, [aDone, b]);
    const atDone = modelsIcon([aDone, b], name, kept).progress ?? 0;
    kept = finishedInBurst(kept, [b]);
    const settled = modelsIcon([b], name, kept);
    expect(atDone).toBeGreaterThanOrEqual(before);
    expect(settled.progress).toBeCloseTo(10 / 16);
    expect(settled.tip.split("<br>")).toHaveLength(1);
    // the burst ends when nothing runs: the next download starts its own total
    expect(finishedInBurst(kept, [])).toEqual([]);
    expect(finishedInBurst(kept, [{ ...b, state: "done" }])).toEqual([]);
  });
  it("a cancelled download leaves the burst", () => {
    const b = pull({ name: "gemma4:12b", state: "downloading", completedBytes: 1, totalBytes: 2 });
    expect(finishedInBurst([], [pull({ name: "qwen3:14b", state: "cancelled", totalBytes: 4 }), b])).toEqual([]);
  });
  it("done and cancelled downloads say nothing", () => {
    expect(modelsIcon([pull({ name: "qwen3:14b", state: "done" }), pull({ name: "gemma4:12b", state: "cancelled" })], name).state).toBe("idle");
  });
});
