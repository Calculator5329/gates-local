// Opt-in probe against the production CLI and an actual Ollama. No stack/fakes.
import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import path from "node:path";
import { createInterface } from "node:readline";
import { expect, test } from "@playwright/test";
import { createClient, decodePayload, decodeServerMessage, type Client, type Payload } from "@gates-local/contracts";
import { DATA_ROOT, ROOT, WEB_ORIGIN } from "./env.ts";
import { assertContextCopied, assertInterruptedCancellation, randomContextWord, requireRealSmokeUrl } from "./real-smoke-checks.ts";

type Arrival = { at: number; payload: Payload<"chat.event"> };

async function productionServer(dataDir: string, ollamaUrl: string): Promise<{ child: ChildProcess; client: Client; socketUrl: string }> {
  const token = randomUUID();
  // In particular, do not inherit a fake measurement or a phone/voice setup.
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (key.startsWith("GATES_LOCAL_")) delete env[key];
  Object.assign(env, { GATES_LOCAL_SERVER_TOKEN: token, GATES_LOCAL_OLLAMA_URL: ollamaUrl, GATES_LOCAL_RUNTIME: "discover-only", GATES_LOCAL_ALLOWED_ORIGINS: WEB_ORIGIN, XDG_DATA_HOME: path.join(dataDir, "xdg") });
  const child = spawn(process.execPath, ["apps/server/src/main.ts", "--port", "0", "--data-dir", dataDir], { cwd: ROOT, env, stdio: ["pipe", "pipe", "pipe"] });
  let stderr = "";
  child.stderr?.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
  try {
    const port = await new Promise<number>((resolve, reject) => {
      const lines = createInterface({ input: child.stdout! });
      const timeout = setTimeout(() => reject(new Error(`Production server readiness timed out: ${stderr}`)), 20_000);
      const done = () => { clearTimeout(timeout); lines.close(); };
      child.once("error", (error) => { done(); reject(error); });
      child.once("exit", (code) => { done(); reject(new Error(`Production server exited ${code}: ${stderr}`)); });
      lines.on("line", (line) => {
        const value: unknown = JSON.parse(line);
        if (typeof value === "object" && value !== null && "ready" in value && value.ready === true && "port" in value && typeof value.port === "number") { done(); resolve(value.port); }
      });
    });
    const socketUrl = `ws://127.0.0.1:${port}/?token=${token}`;
    return { child, client: createClient(new WebSocket(socketUrl)), socketUrl };
  } catch (error) {
    await stop(child);
    throw error;
  }
}

async function stop(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const ended = once(child, "exit");
  child.kill("SIGTERM");
  const kill = setTimeout(() => child.kill("SIGKILL"), 4000);
  await ended;
  clearTimeout(kill);
}

// Release smoke against a real model, run by hand at release; not part of the e2e project.
test("real model streams, stops, recalls the thread and survives a server restart", async ({ page }, info) => {
  test.setTimeout(180_000);
  const url = requireRealSmokeUrl(process.env["GATES_REAL_SMOKE_URL"]);
  const response = await fetch(new URL("/api/version", url), { signal: AbortSignal.timeout(5000) });
  expect(response.ok, "real Ollama must answer; absence is a failure").toBe(true);
  const model = process.env["GATES_REAL_SMOKE_MODEL"] ?? "smollm2:135m";
  await mkdir(DATA_ROOT, { recursive: true });
  const data = await mkdtemp(path.join(DATA_ROOT, "real-smoke-"));
  const evidence: Record<string, unknown> = { model, productionEntry: "apps/server/src/main.ts", measurementOverride: false };
  const started = Date.now();
  let server = await productionServer(data, url);
  const arrivals: Arrival[] = [];
  page.on("websocket", (socket) => socket.on("framereceived", ({ payload }) => {
    const decoded = decodeServerMessage(payload.toString());
    if (decoded.ok && decoded.value.type === "push" && decoded.value.channel === "chat.event") {
      const checked = decodePayload("chat.event", decoded.value.payload);
      // decodePayload checks the channel's Schema; its generic return type is unknown.
      if (checked.ok) arrivals.push({ at: Date.now(), payload: checked.value.payload as Payload<"chat.event"> });
    }
  }));
  try {
    const runtime = await server.client.call("runtime.retry", {});
    expect(runtime.state).toBe("ready");
    const models = await server.client.call("models.refresh", {});
    const installed = models.find((m) => m.name === model);
    expect(installed, `Required real model ${model} is missing; installed: ${models.map((m) => m.name).join(", ")}`).toBeDefined();
    expect(installed!.sizeBytes).toBeLessThan(1_000_000_000);
    evidence["sizeBytes"] = installed!.sizeBytes;
    evidence["startupMs"] = Date.now() - started;
    console.log(`[real-smoke] startup/list ${Date.now() - started} ms, ${model}, ${installed!.sizeBytes} bytes`);

    // First find out what the unchanged fit does. Refusal stops the journey here.
    const fitAt = Date.now();
    const gpu = await server.client.call("gpu.status", {});
    const table = await server.client.call("fit.table", {});
    const fit = table.rows.find((r) => r.model === model && r.numCtx === 8192);
    evidence["gpu"] = gpu;
    evidence["fit"] = fit;
    evidence["fitMs"] = Date.now() - fitAt;
    console.log(`[real-smoke] fit ${Date.now() - fitAt} ms; GPU ${gpu.vendor}; ${fit?.verdict}: ${fit?.message}`);
    expect(fit?.verdict, "Unchanged product must admit this model; do not fake GPU measurements to pass").toMatch(/^(fits|spills)$/);
    await server.client.call("settings.model.update", { model, patch: { temperature: 0, seed: 42, num_predict: 256 } });
    await server.client.call("settings.update", { defaultNumCtx: 8192 });
    await page.addInitScript(() => localStorage.setItem("gates-local.first-run-done", "1"));
    await page.goto(`${WEB_ORIGIN}/?server=${encodeURIComponent(server.socketUrl)}`);
    await expect(page.locator(".composer:not(.blocked)")).toBeVisible();
    await expect(page.locator("#ta")).toBeEnabled();
    const word = randomContextWord();
    const firstPrompt = `My name is ${word}. Remember my name. Now count from 1 to 1000, with one number per line.`;
    const firstStart = Date.now();
    await page.locator("#ta").fill(firstPrompt);
    await page.locator("#ta").press("Enter");
    await expect.poll(() => arrivals.filter((a) => a.payload.event.type === "delta").length, { timeout: 60_000 }).toBeGreaterThanOrEqual(12);
    const beforeStop = arrivals.filter((a) => a.payload.event.type === "delta");
    expect(beforeStop.at(-1)!.at - beforeStop[0]!.at, "tokens must arrive progressively over time, not as one buffered reply").toBeGreaterThan(20);
    expect(arrivals.some((a) => a.payload.event.type === "done"), "Stop must interrupt an unfinished reply").toBe(false);
    const threadId = beforeStop[0]!.payload.threadId;
    evidence["stream"] = { firstDeltaMs: beforeStop[0]!.at - firstStart, deltas: beforeStop.length, spanMs: beforeStop.at(-1)!.at - beforeStop[0]!.at };
    console.log(`[real-smoke] progressive stream ${JSON.stringify(evidence["stream"])}`);
    const stopAt = Date.now();
    await page.getByRole("button", { name: "Stop", exact: true }).click();
    const firstReply = page.locator(".turn.a").first();
    await expect(page.locator(".stop-note")).toBeVisible();
    await expect(page.locator(".writing")).toHaveCount(0);
    await expect.poll(() => arrivals.some((a) => a.payload.event.type === "error" && a.payload.event.code === "cancelled")).toBe(true);
    const cancellation = arrivals.map((a) => a.payload.event).find((event) => event.type === "error" && event.code === "cancelled");
    if (cancellation?.type !== "error") throw new Error("Stop produced no cancelled event");
    assertInterruptedCancellation(cancellation.message);
    const partial = await firstReply.locator(".md").innerText();
    expect(partial.trim().length).toBeGreaterThan(0);
    const cancelMs = Date.now() - stopAt;
    const stoppedCount = arrivals.length;
    // A bounded observation window is intentional: cancellation must prevent later deltas.
    await page.waitForTimeout(500);
    expect(arrivals).toHaveLength(stoppedCount);
    expect(await firstReply.locator(".md").innerText()).toBe(partial);
    evidence["stop"] = { ms: Date.now() - stopAt, cancelMs, quietWindowMs: 500, message: cancellation.message, partial };
    console.log(`[real-smoke] Stop ${Date.now() - stopAt} ms; partial retained ${JSON.stringify(partial)}`);

    // The made-up word is absent from this question and the system prompt.
    const secondStart = Date.now();
    await page.locator("#ta").fill("What is my name? Reply with my name only.");
    await page.locator("#ta").press("Enter");
    const secondReply = page.locator(".turn.a").last();
    await expect(secondReply).toHaveClass(/done/, { timeout: 60_000 });
    const answer = await secondReply.locator(".md").innerText();
    assertContextCopied(answer, word);
    expect(await firstReply.locator(".md").innerText(), "partial survives the following turn").toBe(partial);
    const completed = arrivals.findLast((a) => a.payload.event.type === "done");
    expect(completed).toBeDefined();
    const saved = await server.client.call("threads.get", { threadId });
    expect(saved.messages.some((m) => m.role === "assistant" && m.content.toLowerCase().includes(word))).toBe(true);
    evidence["stoppedPartialSaved"] = saved.messages.some((m) => m.role === "assistant" && m.content.trim() === partial.trim());
    evidence["context"] = { word, answer, ms: Date.now() - secondStart };
    console.log(`[real-smoke] context ${Date.now() - secondStart} ms; expected ${word}, got ${JSON.stringify(answer)}`);
    await page.screenshot({ path: info.outputPath("real-smoke.png") });

    const restartAt = Date.now();
    server.client.close();
    await stop(server.child);
    server = await productionServer(data, url);
    const restored = await server.client.call("threads.get", { threadId });
    expect(restored).toEqual(saved);
    await page.goto(`${WEB_ORIGIN}/?server=${encodeURIComponent(server.socketUrl)}#thread=${threadId}`);
    await expect(page.locator(".turn.a .md").last()).toContainText(new RegExp(word, "i"));
    evidence["restartMs"] = Date.now() - restartAt;
    evidence["totalMs"] = Date.now() - started;
    console.log(`[real-smoke] restart/persistence ${Date.now() - restartAt} ms; total ${Date.now() - started} ms`);
  } finally {
    server.client.close();
    await stop(server.child);
    await writeFile(info.outputPath("evidence.json"), JSON.stringify(evidence, null, 2));
    await info.attach("real-smoke-evidence", { body: JSON.stringify(evidence, null, 2), contentType: "application/json" });
  }
});
