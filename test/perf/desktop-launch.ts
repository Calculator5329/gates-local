/// <reference lib="dom" />
// Built Electron main/preload/client and the real supervised server. Only
// Ollama and GPU reads are faked, as in the native clipboard fixtures.
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import path from "node:path";
import { setTimeout as pause } from "node:timers/promises";
import { expect } from "@playwright/test";
import { FAKE_PORT, FAKE_URL, ROOT } from "../e2e/env.ts";
import { restoreFixture } from "./fixture.ts";
import { ownProcesses } from "./processes.ts";
import { browserProbe, type Observation } from "./probe.ts";
import { metric } from "./stats.ts";
import { NativeCdp } from "./native-cdp.ts";

interface Event { name: string; at: number; modules?: number; typescript?: number; loadMs?: number }
export function launchPhases(start: number, events: Event[], navigation: number, usable: number) {
  function at(name: string) {
    const rows = events.filter(e => e.name === name);
    if (rows.length !== 1 || !Number.isFinite(rows[0]!.at)) throw new Error(`Expected one desktop launch event: ${name}`);
    return rows[0]!.at;
  }
  const main = at("main-entry"), ready = at("app-ready"), window = at("window-shown");
  const spawn = at("server-spawn"), server = at("server-ready");
  if (!(start <= main && main <= ready && ready <= spawn && spawn <= server && server <= navigation && navigation <= usable && main <= window && window <= usable)) throw new Error("Desktop launch phases are out of order");
  return {
    "desktop-launch": usable - start,
    "desktop-launch.process-to-main": main - start,
    "desktop-launch.main-to-app-ready": ready - main,
    "desktop-launch.window-shown": window - start,
    "desktop-launch.server-spawn": spawn - start,
    "desktop-launch.server-start": server - spawn,
    "desktop-launch.server-ready": server - start,
    "desktop-launch.server-to-navigation": navigation - server,
    "desktop-launch.navigation-to-composer": usable - navigation,
  };
}

export async function desktopLaunchTimes(target: string, fixture: string, samples: number, out: string, signal: AbortSignal) {
  const cache = path.join(homedir(), ".cache", "gates-local-perf");
  mkdirSync(cache, { recursive: true }); mkdirSync(out, { recursive: true });
  const work = mkdtempSync(path.join(cache, "desktop-"));
  const gpu = path.join(work, "gpu.json");
  const renderer = path.join(work, "renderer.cjs");
  writeFileSync(renderer, `const { contextBridge } = require("electron"); if (location.protocol === "gates-local:") contextBridge.executeInMainWorld({ func: ${browserProbe.toString()}, args: [false] });`);
  const processes = ownProcesses(signal);
  let cdp: NativeCdp | undefined;
  const onAbort = () => cdp?.close();
  signal.addEventListener("abort", onAbort, { once: true });
  const rows = new Map<string, number[]>();
  const records: unknown[] = [];
  try {
    // Electron may prepare its downloaded binary on first resolution. That is
    // build/setup work, outside a built application's process-start clock.
    const binary = createRequire(path.join(target, "apps/desktop/package.json"))("electron") as string;
    const fake = processes.spawn(process.execPath, ["test/fake-ollama/main.ts", "--port", String(FAKE_PORT), "--gpu-state", gpu], { cwd: ROOT, stdio: ["ignore", "pipe", "inherit"], detached: true });
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("Desktop fake did not start")), 15_000);
      let output = "";
      fake.stdout?.on("data", (chunk: Buffer) => { output += chunk.toString(); if (output.includes("fake ollama on")) { clearTimeout(timer); resolve(); } });
      fake.once("error", error => { clearTimeout(timer); reject(error); });
      fake.once("exit", () => { clearTimeout(timer); reject(new Error("Desktop fake exited")); });
    });
    for (let sample = 0; sample < samples; sample++) {
      signal.throwIfAborted();
      const run = path.join(work, String(sample)); mkdirSync(run);
      restoreFixture(fixture, path.join(run, "data"));
      const eventsFile = path.join(out, `desktop-launch-${sample}.jsonl`);
      const env: NodeJS.ProcessEnv = { ...process.env,
        GL_PERF_TARGET: target, GL_PERF_DESKTOP_EVENTS: eventsFile, GL_PERF_DESKTOP_RENDERER: renderer,
        GL_PERF_DESKTOP_SERVER_PROBE: path.join(ROOT, "test/perf/server-entry.cjs"),
        GATES_LOCAL_USER_DATA: path.join(run, "profile"), GATES_LOCAL_DATA_DIR: path.join(run, "data"),
        GATES_LOCAL_OLLAMA_URL: FAKE_URL, GATES_LOCAL_COMFY_URL: "http://127.0.0.1:1", GATES_LOCAL_OLLAMA_BINARY: "none", GATES_LOCAL_RUNTIME: "discover-only",
        GATES_LOCAL_NVIDIA_SMI: path.join(ROOT, `test/fake-ollama/nvidia-smi.${process.platform === "linux" ? "sh" : "ts"}`), GATES_LOCAL_MEMINFO: path.join(target, "test/fake-ollama/meminfo.txt"),
        GATES_LOCAL_FAKE_GPU_STATE: gpu, GATES_LOCAL_UPDATE_TEST_ROOT: work, XDG_DATA_HOME: path.join(run, "xdg"),
      };
      for (const key of ["ELECTRON_RUN_AS_NODE", "GATES_LOCAL_WEB_URL", "GATES_LOCAL_WEB", "GATES_LOCAL_SERVER_ENTRY", "NODE_OPTIONS"]) delete env[key];
      // Profiling is opt-in for a separate diagnostic invocation, never mixed
      // into the paired comparison's timing samples.
      if (process.env["GL_PERF_DESKTOP_PROFILE"]) env["GL_PERF_DESKTOP_PROFILE"] = out;
      const started = performance.timeOrigin + performance.now();
      // A normal native launch, as in the desktop smoke fixture. _electron.launch
      // pauses app.ready until its inspector connects, inflating real startup.
      const electron = processes.spawn(binary,
        [path.join(ROOT, "test/perf/desktop-entry.cjs"), "--remote-debugging-port=0", ...(process.platform === "linux" ? ["--ozone-platform=x11"] : [])],
        { env, stdio: ["ignore", "ignore", "pipe"], detached: true });
      try {
        const endpoint = await new Promise<string>((resolve, reject) => {
          const timer = setTimeout(() => reject(new Error("Native Electron did not expose DevTools")), 20_000);
          let output = "";
          electron.stderr?.on("data", (chunk: Buffer) => {
            output += chunk.toString();
            const match = /DevTools listening on (ws:\/\/\S+)/.exec(output);
            if (match?.[1]) { clearTimeout(timer); resolve(match[1]); }
          });
          electron.once("error", error => { clearTimeout(timer); reject(error); });
          electron.once("exit", () => { clearTimeout(timer); reject(new Error("Native Electron exited before DevTools")); });
        });
        const targetsUrl = new URL("/json/list", endpoint.replace(/^ws:/, "http:"));
        const deadline = Date.now() + 20_000;
        while (!cdp) {
          signal.throwIfAborted();
          const targets = await (await fetch(targetsUrl, { signal: AbortSignal.timeout(1000) })).json() as { type: string; webSocketDebuggerUrl?: string }[];
          const page = targets.find(item => item.type === "page" && item.webSocketDebuggerUrl);
          if (page?.webSocketDebuggerUrl) cdp = await NativeCdp.connect(page.webSocketDebuggerUrl);
          else if (Date.now() > deadline) throw new Error("Native Electron has no page target");
          else await pause(20, undefined, { signal });
        }
        for (;;) {
          signal.throwIfAborted();
          try { if (await cdp.evaluate('location.protocol === "gates-local:" && typeof window.perfJourney === "object"')) break; }
          catch { /* The initial status page may be navigating to the client. */ }
          if (Date.now() > deadline) throw new Error("Native client did not navigate");
          await pause(20, undefined, { signal });
        }
        const observation = await cdp.evaluate("window.perfJourney.result") as Observation;
        const navigation = await cdp.evaluate("performance.timeOrigin");
        if (typeof navigation !== "number") throw new Error("Missing native navigation origin");
        const usable = navigation + observation.elapsed;
        expect(await cdp.evaluate('!document.querySelector(".composer.blocked") && document.querySelector("#ta").disabled === false')).toBe(true);
        await cdp.evaluate('document.querySelector("#ta").focus(); true');
        await cdp.call("Input.dispatchKeyEvent", { type: "keyDown", key: "x", code: "KeyX", text: "x" });
        await cdp.call("Input.dispatchKeyEvent", { type: "keyUp", key: "x", code: "KeyX" });
        expect(await cdp.evaluate('document.querySelector("#ta").value')).toBe("x");
        const events = readFileSync(eventsFile, "utf8").trim().split("\n").map(line => JSON.parse(line) as Event);
        const phases = launchPhases(started, events, navigation, usable);
        const imports = events.find(event => event.name === "server-imports");
        if (!imports || imports.modules === undefined || imports.typescript === undefined || imports.loadMs === undefined) throw new Error("Missing server import counters");
        for (const [name, value] of [["desktop-launch.server-modules", imports.modules], ["desktop-launch.server-typescript-modules", imports.typescript]] as const) rows.set(name, [...rows.get(name) ?? [], value]);
        rows.set("desktop-launch.server-module-load-time", [...rows.get("desktop-launch.server-module-load-time") ?? [], imports.loadMs]);
        for (const [name, value] of Object.entries(phases)) rows.set(name, [...rows.get(name) ?? [], value]);
        rows.set("desktop-launch.renderer-long-task-time", [...rows.get("desktop-launch.renderer-long-task-time") ?? [], observation.longTasks.reduce((a, b) => a + b, 0)]);
        records.push({ started, events, navigation, usable, phases, renderer: observation });
        if (sample === 0) {
          const screenshot = await cdp.call("Page.captureScreenshot", { format: "png" });
          if (typeof screenshot !== "object" || screenshot === null || !("data" in screenshot) || typeof screenshot.data !== "string") throw new Error("No native screenshot");
          writeFileSync(path.join(out, "desktop-launch.png"), Buffer.from(screenshot.data, "base64"), { flag: "wx" });
        }
      } finally {
        try { cdp?.close(); cdp = undefined; }
        finally { await processes.stop(electron); }
      }
    }
    writeFileSync(path.join(out, "desktop-events.json"), JSON.stringify(records, null, 2) + "\n", { flag: "wx" });
    return [...rows].map(([action, values]) => metric(action, action.endsWith("-modules") ? "count" : "ms", values));
  } finally {
    signal.removeEventListener("abort", onAbort);
    try { cdp?.close(); } finally { await processes.close(); }
  }
}
