// Settings sections rendered from the store: what Runtime, Tools, Image generation, Library and
// Advanced say and offer in each state the server can be in.
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ImagePresets, Settings, Source } from "@gates-local/contracts";
import { methodSamples } from "@gates-local/contracts/testing";
import type { State } from "../lib/store/store.ts";

vi.mock("../lib/store/store.ts", async (original) => {
  const actual = await original<typeof import("../lib/store/store.ts")>();
  return { ...actual, useStore: <T>(selector: (s: State) => T) => selector(actual.getState()) };
});
const { getState, setState } = await import("../lib/store/store.ts");
let view: typeof import("./Settings.tsx");
const initial = getState();
const LINUX = "Mozilla/5.0 (X11; Linux x86_64)";
const WINDOWS = "Mozilla/5.0 (Windows NT 10.0; Win64; x64)";

beforeEach(async () => {
  vi.stubGlobal("window", {});
  vi.stubGlobal("matchMedia", () => ({ matches: false }));
  vi.stubGlobal("navigator", { userAgent: LINUX });
  view ??= await import("./Settings.tsx");
});
afterEach(() => { setState(initial); vi.unstubAllGlobals(); });

const settings = (over: Partial<Settings> = {}): Settings => ({ defaultNumCtx: 16384, thinking: true, theme: "dark", runtimeMode: "system", tools: true, imageGen: true, ...over });
const PRESETS: ImagePresets = methodSamples["image.presets"].result;
const source = (over: Partial<Source> = {}): Source => ({ id: "s1", kind: "folder", label: "docs", path: "/home/me/docs", addedAt: 1, state: "ready", ...over });

function render(section: State["section"], over: Partial<State> = {}): string {
  setState({ ...initial, conn: { kind: "open" }, view: "settings", section, settings: settings(), sources: [], unavailable: {}, ...over });
  return renderToStaticMarkup(createElement(view.SettingsView));
}
/** A Tools row's word and dot, found by its name. */
function tool(html: string, name: string): { word: string; dot: string } {
  const m = new RegExp(`<b>${name}</b>.*?<span class="stat"><span class="dot (\\w+)"></span>([^<]*)</span>`).exec(html);
  if (m === null) throw new Error(`no ${name} row`);
  return { dot: m[1] ?? "", word: m[2] ?? "" };
}
/** The Image generation status row: its dot, its word, and the rest of the row up to the next one. */
function imageState(over: Partial<State>): { dot: string; word: string; row: string } {
  const html = render("images", { imagePresets: PRESETS, ...over });
  const start = html.indexOf('<div class="grp-t">Connection</div>');
  const m = /<span class="stat"><span class="dot (\w+)"><\/span>([^<]*)<\/span><\/b>(.*?)(?:<div class="srow"|$)/.exec(html.slice(start));
  if (m === null) throw new Error("no status row");
  return { dot: m[1] ?? "", word: m[2] ?? "", row: m[3] ?? "" };
}

const readyRuntime = (owner: "app" | "external") => ({ state: "ready", owner, baseUrl: "http://127.0.0.1:11435", modelsDir: "/data/models" }) as const;
const makeImagesSwitch = (presets: ImagePresets) => /data-testid="settings.tools.make-images" aria-checked="(\w+)"/.exec(render("tools", { imagePresets: presets, imageStatus: { state: "ready", owner: "external" } }))?.[1];
const spaced = (t: string) => t.replace(/\u00a0/g, " ");
const folderField = (disk: ImagePresets["disk"]) => {
    const html = render("images", { imagePresets: { ...PRESETS, disk }, imageStatus: { state: "ready", owner: "external" } });
    return { placeholder: /placeholder="([^"]*)" spellCheck="false" value=""/.exec(html)?.[1], line: /data-testid="settings.images.folder-line">([^<]*)</.exec(html)?.[1] };
};

describe("Runtime", () => {
  it("a runtime that is not ready has no owner, so the mode chosen says which way the switch goes", () => {
    const runtime = { state: "stopped", owner: "none", baseUrl: "http://127.0.0.1:11435" } as const;
    expect(render("runtime", { runtime, settings: settings({ runtimeMode: "app" }) })).toContain(">Use the system Ollama</button>");
    expect(render("runtime", { runtime, settings: settings({ runtimeMode: "system" }) })).toContain(">Use Gates Local&#x27;s Ollama</button>");
  });

  it("on the desktop the models folder shows only for the app's own Ollama once it is ready; a browser shows the server's", () => {
    expect(render("runtime", { runtime: readyRuntime("external") })).toContain("<b>Models folder</b>");
    vi.stubGlobal("window", { gatesLocal: {} });
    expect(render("runtime", { runtime: readyRuntime("external") })).not.toContain("Models folder");
    expect(render("runtime", { runtime: { ...readyRuntime("app"), state: "starting" } })).not.toContain("Models folder");
    expect(render("runtime", { runtime: readyRuntime("app") })).toContain("<b>Models folder</b>");
  });
});

describe("Tools", () => {
  const shellReady = { state: "ready" } as const;

  it("with Tools off every row reads Turned off, dimmed; before the Library is read Checking; where it cannot be read Not available", () => {
    const off = render("tools", { settings: settings({ tools: false }), sources: [source()], shellStatus: shellReady });
    expect(tool(off, "Read files")).toEqual({ word: "Turned off", dot: "off" });
    expect(tool(off, "Run commands")).toEqual({ word: "Turned off", dot: "off" });
    expect(off).toMatch(/<div class="srow tool dim"><span class="sl"><b>Read files<\/b>/);
    expect(tool(render("tools", { sources: undefined, shellStatus: shellReady }), "Read files")).toEqual({ word: "Checking", dot: "run" });
    expect(tool(render("tools", { sources: "na", shellStatus: shellReady }), "Read files")).toEqual({ word: "Not available", dot: "off" });
  });

  it("an empty Library reads Library empty on every row, whatever each tool lacks otherwise", () => {
    const html = render("tools", { sources: [], shellStatus: shellReady });
    expect(tool(html, "Read files").word).toBe("Library empty");
    expect(tool(html, "Run commands").word).toBe("Library empty");
    vi.stubGlobal("navigator", { userAgent: WINDOWS });
    expect(tool(render("tools", { sources: [] }), "Query databases").word).toBe("Library empty");
    // a Library with only a database: the file tool's own missing word
    expect(tool(render("tools", { sources: [source({ kind: "sqlite" })] }), "Read files").word).toBe("No folders or files");
  });

  it("what the machine lacks comes first: a sandbox that is off says so even with an empty Library", () => {
    const html = render("tools", { sources: [], shellStatus: { state: "off", word: "Needs bubblewrap" } });
    expect(tool(html, "Run commands")).toEqual({ word: "Needs bubblewrap", dot: "off" });
  });

  it("a sandbox that runs but is short of something says the server's words with an amber dot", () => {
    const html = render("tools", { sources: [source()], shellStatus: { state: "ready", word: "No sqlite3" } });
    expect(tool(html, "Run commands")).toEqual({ word: "No sqlite3", dot: "warn" });
    expect(tool(render("tools", { sources: [source()], shellStatus: shellReady }), "Run commands")).toEqual({ word: "Ready", dot: "ok" });
  });

  it("the Tools switch sits on the title of the one card it turns on", () => {
    expect(render("tools", { shellStatus: shellReady })).toMatch(/<div class="grp-t">Tools<\/div><\/div><div class="grp-a"><button type="button" class="switch" role="switch" data-testid="settings.tools.enable"/);
  });

  it("Make images left unset is on once a setup can run, and off with no setup listed or no GPU", () => {
    expect(makeImagesSwitch(PRESETS)).toBe("true");
    expect(makeImagesSwitch({ ...PRESETS, presets: [] })).toBe("false");
    expect(makeImagesSwitch({ ...PRESETS, noGpu: "Image mode needs a GPU with 4 GB." })).toBe("false");
  });
});

describe("Image generation", () => {
  const nowhere = { imageStatus: { state: "off", owner: "none", nowhere: true }, settings: settings({ imageGen: false }) } as const;

  const guideHref = () => /href="([^"]*)" data-testid="settings.images.setup-guide"/.exec(render("images", { ...nowhere, unavailable: { "image.setup": true } }))?.[1];

  it("How to set up goes to the image section of the setup guide for this computer's system", () => {
    expect(guideHref()).toBe("https://github.com/Calculator5329/gates-local/blob/main/docs/setup/linux.md#4-optional-image-generation-with-comfyui");
    vi.stubGlobal("navigator", { userAgent: WINDOWS });
    expect(guideHref()).toBe("https://github.com/Calculator5329/gates-local/blob/main/docs/setup/windows.md#4-optional-image-generation-with-comfyui");
  });

  it("where images cannot be set up here, the row says why, ending on the address box below, with the guide and no Set up button", () => {
    const html = render("images", { ...nowhere, imageSetup: { why: "This computer has no graphics card for pictures. To use a ComfyUI elsewhere, set its address in Settings." } });
    expect(html).toContain("<b>Set up images</b><span class=\"d\">This computer has no graphics card for pictures. To use a ComfyUI elsewhere, set its address below.</span>");
    expect(html).toContain('data-testid="settings.images.setup-guide"');
    expect(html).not.toContain('data-testid="settings.images.set-up"');
  });

  it("only Settings' copy of the server's why points below; any other ending stays whole", () => {
    expect(view.addressBelow("No ComfyUI answers. To use one elsewhere, set its address in Settings.")).toBe("No ComfyUI answers. To use one elsewhere, set its address below.");
    expect(view.addressBelow("Set its address in Settings. Then try again.")).toBe("Set its address in Settings. Then try again.");
  });

  it("with no engine anywhere there is no Generate images switch, and the address row stays for a ComfyUI of one's own", () => {
    const html = render("images", { ...nowhere, imageSetup: methodSamples["image.setupInfo"].result });
    expect(html).not.toContain('data-testid="settings.images.enable"');
    expect(html).toContain('data-testid="settings.images.set-up"');
    expect(html).toContain('data-testid="settings.images.address"');
  });

  it("a setup's size is its download, and the disk it takes beside it only when that is more", () => {
    const GB = 1024 ** 3;
    expect(spaced(view.setupSize(9.6 * GB, undefined))).toBe("9.6 GB");
    expect(spaced(view.setupSize(9.6 * GB, 9.6 * GB))).toBe("9.6 GB");
    expect(spaced(view.setupSize(9.6 * GB, 16.5 * GB))).toBe("9.6 GB download · 16.5 GB on disk");
  });

  it("the setup row has one grey line: the running step, else a drive too full, else how slow the processor is", () => {
    const info = methodSamples["image.setupInfo"].result;
    const line = (setup: typeof info) => /<span class="d">([^<]*)<span class="mono setup-size"/.exec(render("images", { ...nowhere, imageSetup: setup }))?.[1];
    expect(line(info)).toBe("No GPU: a picture takes 2 to 4 minutes.");
    const full = { ...info, freeBytes: 1024 ** 3 };
    expect(line(full)).toMatch(/^Needs .* free; 1\.0\sGB is free\.$/);
    expect(line({ ...full, progress: { step: "model", completedBytes: 0, totalBytes: 1024 ** 3 } })).toBe("Downloading the image model");
  });

  it("the sizes take a line of their own under the sentence", async () => {
    const { readFileSync } = await import("node:fs");
    const css = readFileSync(new URL("../app/styles.css", import.meta.url), "utf8");
    expect(css).toMatch(/\.sl \.d \.setup-size\{display:block;/);
    expect(render("images", { ...nowhere, imageSetup: methodSamples["image.setupInfo"].result })).toMatch(/<span class="d">No GPU[^<]*<span class="mono setup-size"/);
  });

  it("the engine the app started reads Running and one it found Connected; the app's own, stopped, reads Ready and another's Found", () => {
    expect(imageState({ imageStatus: { state: "ready", owner: "app" } }).word).toBe("Running");
    expect(imageState({ imageStatus: { state: "ready", owner: "external" } }).word).toBe("Connected");
    expect(imageState({ imageStatus: { state: "stopped", owner: "app", own: true } }).word).toBe("Ready");
    expect(imageState({ imageStatus: { state: "stopped", owner: "external" } }).word).toBe("Found");
  });

  it("a missing ComfyUI is amber, something to set up; only a real error is red", () => {
    expect(imageState({ imageStatus: { state: "missing", owner: "none", addressSet: true } }).dot).toBe("warn");
    expect(imageState({ imageStatus: { state: "error", owner: "external", detail: "boom" } }).dot).toBe("err");
  });

  it("the status row offers one thing: Retry on an error, Open at the engine while ready or busy, and nothing while it is missing", () => {
    const err = imageState({ imageStatus: { state: "error", owner: "external", detail: "ComfyUI crashed." } }).row;
    expect(err).toContain('data-testid="settings.images.retry"');
    expect(err).not.toContain("open-comfyui");
    for (const state of ["ready", "busy"] as const) {
      const row = imageState({ imageStatus: { state, owner: "external", baseUrl: "http://10.0.0.5:8188" } }).row;
      expect(row, state).toContain('href="http://10.0.0.5:8188" data-testid="settings.images.open-comfyui"');
      expect(row, state).not.toContain("settings.images.retry");
    }
    // Not connected is shown here only to a phone: elsewhere no engine anywhere puts the set-up in this page's place
    for (const addressSet of [false, true]) {
      const { word, row } = imageState({ imageStatus: { state: "missing", owner: "none", addressSet }, unavailable: addressSet ? {} : { "settings.update": true } });
      expect(word).toBe(addressSet ? "Not running" : "Not connected");
      expect(row, word).toMatch(/^<\/div><div class="sv"><\/div><\/div>/);
    }
  });

  it("an empty download folder says ComfyUI's own folders, or the engine's when it named one; the line for a ComfyUI of one's own shows only when the server gives it", () => {
    expect(folderField(undefined)).toEqual({ placeholder: "ComfyUI&#x27;s model folders", line: undefined });
    expect(folderField({ picked: false, folder: "/opt/comfy/models" })).toEqual({ placeholder: "/opt/comfy/models", line: undefined });
    expect(folderField({ picked: true, folder: "/big/models", line: "gates_local: {base_path: /big/models}" })).toEqual({ placeholder: "ComfyUI&#x27;s model folders", line: "gates_local: {base_path: /big/models}" });
  });
});

describe("Library and Advanced", () => {
  it("a clone's line names the repository without its GitHub address or .git", () => {
    const at = Date.UTC(2026, 10, 13, 12);
    expect(view.copiedFrom("https://github.com/owner/repo.git", at)).toMatch(/^Copied from owner\/repo on /);
    expect(view.copiedFrom("https://github.com/owner/repo/", at)).toMatch(/^Copied from owner\/repo on /);
  });

  it("the line under Files and folders, about the latest version, is what sets them apart from a database", () => {
    const html = render("library", { sources: [] });
    expect(html).toContain('<b>No folders or files yet.</b><span class="d"><span class="src-help">The model always sees the latest version.</span>');
    expect(html).toContain('<b>Add a database</b><span class="d"><span class="src-help">A SQLite file of your own.</span>');
    expect(html.split("latest version").length - 1).toBe(1);
  });

  it("a browser has no data folder row; the desktop holds a placeholder row until the folder is read", () => {
    expect(render("advanced")).not.toContain("Data folder");
    vi.stubGlobal("window", { gatesLocal: { dataFolder: () => Promise.resolve("/data") } });
    expect(render("advanced")).toMatch(/<div class="srow" aria-busy="true"><div class="sl"><b>Data folder<\/b>/);
    expect(render("advanced", { dataFolder: "/home/me/.gates" })).toMatch(/<b>Data folder<\/b><span class="d"><span class="mono">\/home\/me\/\.gates<\/span>/);
  });
});

describe("General", () => {
  it("each accent's dot is this theme's own step of it, Neutral the text colour, and the picked one is pressed", () => {
    const html = render("general", { settings: settings({ accent: "green" }) });
    expect(html).toMatch(/data-testid="settings.appearance.accent-neutral" aria-label="Neutral" aria-pressed="false" data-tip="Neutral" style="--sw:var\(--foreground\)"/);
    expect(html).toMatch(/data-testid="settings.appearance.accent-green" aria-label="Green" aria-pressed="true" data-tip="Green" style="--sw:var\(--accent-green\)"/);
    expect([...html.matchAll(/settings\.appearance\.accent-(\w+)/g)].map((m) => m[1])).toEqual(["neutral", "green", "blue", "violet", "amber", "red"]);
  });
});

it("a phone, which may not change settings or the Library, is offered no control that would be refused", () => {
  const phone = { unavailable: { "settings.update": true, "sources.add": true, "sources.remove": true }, sources: [source()], shellStatus: { state: "ready" }, imageStatus: { state: "ready", owner: "external" } } as const;
  const general = render("general", phone);
  expect(general).not.toContain("settings.appearance.");
  const tools = render("tools", phone);
  expect(tools).not.toContain('role="switch"');
  const library = render("library", phone);
  expect(library).not.toContain("settings.source.more-");
  expect(library).not.toContain("settings.library.add-");
  const images = render("images", phone);
  expect(images).not.toContain('role="switch"');
  expect(images).not.toContain("settings.images.address");
  expect(render("advanced", phone)).not.toContain("settings.advanced.reset");
});
