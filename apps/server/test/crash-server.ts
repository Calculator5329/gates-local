// Child process for the kill-mid-reply test in app.test.ts. Run with plain
// `node` (type stripping): node crash-server.ts <dir> <marker>.
// A real app and store over a fake Ollama: one finished turn, then a reply
// that streams forever. It prints one JSON "ready" line once the reply is on
// disk past its first words. The parent SIGKILLs it while it keeps streaming.

import { readFileSync } from "node:fs";
import type { ServerResponse } from "node:http";
import path from "node:path";

import { createApp } from "../src/app.ts";
import { json, startFakeServer } from "../src/fit/fake-http.ts";
import { createModelCatalog } from "../src/runtime/models.ts";
import { createOllamaRuntime } from "../src/runtime/runtime.ts";
import { freePort } from "../src/runtime/test-fakes.ts";
import { openThreadStore } from "../src/threads/store.ts";

const [dir, marker] = process.argv.slice(2);
if (!dir || !marker) {
  process.stderr.write("usage: crash-server.ts <dir> <marker>\n");
  process.exit(2);
}

// A writer that never gets a reply on disk says so instead of hanging the parent.
setTimeout(() => {
  process.stderr.write("the streaming reply never reached the database\n");
  process.exit(3);
}, 5_000).unref();

const MODEL = "qwen3.5:9b";
const SHOW = JSON.parse(readFileSync(new URL("../src/fit/fixtures/show-qwen3-5-9b.json", import.meta.url), "utf8")) as unknown;
const TAGS = { models: [{ name: MODEL, model: MODEL, size: 6594474711, digest: "sha256:a", modified_at: "2026-11-01T10:00:00Z" }] };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const line = (value: unknown) => `${JSON.stringify(value)}\n`;
const piece = (text: string) => line({ model: MODEL, message: { role: "assistant", content: text }, done: false });

let chats = 0;
const chat = async (res: ServerResponse): Promise<void> => {
  res.writeHead(200, { "content-type": "application/x-ndjson" });
  if (++chats === 1) {
    res.end(`${piece("first answer")}${line({ model: MODEL, message: { role: "assistant", content: "" }, done: true, done_reason: "stop", eval_count: 2 })}`);
    return;
  }
  for (let n = 0; ; n++) {
    res.write(piece(`${marker}-${n} `));
    await sleep(2);
  }
};

const ollama = await startFakeServer({
  "GET /": (_b, res) => {
    res.writeHead(200, { "content-type": "text/plain" });
    res.end("Ollama is running");
  },
  "GET /api/version": (_b, res) => json(res, 200, { version: "0.0.9-fake" }),
  "GET /api/tags": (_b, res) => json(res, 200, TAGS),
  "GET /api/ps": (_b, res) => json(res, 200, { models: [] }),
  "POST /api/show": (_b, res) => json(res, 200, SHOW),
  "POST /api/chat": (_b, res) => chat(res),
});

const store = openThreadStore(path.join(dir, "threads.sqlite"));
const runtime = createOllamaRuntime({
  externalBaseUrl: ollama.baseUrl,
  appPort: await freePort(),
  appDataDir: path.join(dir, "appdata"),
  allowInstall: false,
  env: { PATH: "" },
  home: path.join(dir, "home"),
  systemModelsDirs: [],
  probeTimeoutMs: 500,
});
const catalog = createModelCatalog(() => runtime.baseUrl());
const app = createApp({
  dataDir: dir,
  store,
  runtime,
  catalog,
  draftEveryMs: 5,
  push: () => undefined,
  fit: {
    runNvidiaSmi: async (args) => (args[0]?.startsWith("--query-gpu") ? "16303, 1303, 15000\n" : ""),
    readMeminfo: async () => "MemTotal: 32541464 kB\nMemAvailable: 30000000 kB\n",
  },
  log: () => undefined,
});
await runtime.discover();

const thread = store.createThread({ title: "crash test" });
const send = (content: string) => app.handlers["chat.send"]({ threadId: thread.id, content, model: MODEL, numCtx: 16384 }, { clientId: 1 });
await send("first question");
while (app.activeTurns() > 0) await sleep(1);
const second = await send("second question");

for (;;) {
  const reply = store.getThread(thread.id).messages.at(-1);
  // past the first write: the row has been updated at least once
  if (reply?.interrupted === true && reply.content.split(" ").length > 20) {
    process.stdout.write(`${JSON.stringify({ ready: true, threadId: thread.id, questionId: second.userMessage.id, written: reply.content })}\n`);
    break;
  }
  await sleep(5);
}
await new Promise(() => undefined);
