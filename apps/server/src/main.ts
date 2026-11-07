// CLI entry the Electron supervisor spawns (contract: apps/desktop/README.md):
//   <electron or node> apps/server/src/main.ts --port <n> --data-dir <dir>
// with the per-launch token in GATES_LOCAL_SERVER_TOKEN. Prints one
// `{"ready":true,"port":<n>}` line on stdout once the socket listens; every
// log goes to stderr. Exits on stdin EOF (parent death), SIGTERM and SIGINT.
//
// Knobs (environment):
//   GATES_LOCAL_ALLOWED_ORIGINS  comma list added to the dev web origins
//   GATES_LOCAL_OLLAMA_URL       use this Ollama as the external one
//   GATES_LOCAL_RUNTIME          "discover-only": never install, start or stop Ollama (tests)
import { mkdirSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { createApp, type App } from "./app.ts";
import { createSources } from "./sources/index.ts";
import { createModelCatalog } from "./runtime/models.ts";
import { createOllamaRuntime } from "./runtime/runtime.ts";
import { openThreadStore, type ThreadStore } from "./threads/store.ts";
import { startWsServer, type WsServer } from "./ws/server.ts";

const TOKEN_ENV = "GATES_LOCAL_SERVER_TOKEN";
/** The supervisor SIGKILLs at 3 s; exit before that whatever hangs. */
const HARD_EXIT_MS = 2500;

// The Vite dev client. The packaged renderer loads file://, and what Origin
// its WebSocket upgrade carries ("file://", "null" or none) is not measured
// yet; add it here once a real packaged Electron run shows the header.
const DEFAULT_ORIGINS = ["http://127.0.0.1:5187", "http://localhost:5187"];

const log = (line: string) => process.stderr.write(`[server] ${line}\n`);

function die(message: string, code = 2): never {
  process.stderr.write(`gates-local-server: ${message}\n`);
  process.exit(code);
}

function parseFlags(): { port: number; dataDir: string } {
  let values: { port?: string | undefined; "data-dir"?: string | undefined };
  try {
    ({ values } = parseArgs({
      options: { port: { type: "string" }, "data-dir": { type: "string" } },
      strict: true,
      allowPositionals: false,
    }));
  } catch (e) {
    die((e as Error).message);
  }
  const portText = values.port;
  const port = portText === undefined ? Number.NaN : Number(portText);
  if (!Number.isInteger(port) || port < 0 || port > 65535) die(`--port must be an integer 0-65535, got ${String(portText)}`);
  const dataDir = values["data-dir"];
  if (dataDir === undefined || dataDir === "") die("--data-dir is required");
  return { port, dataDir: path.resolve(dataDir) };
}

async function main(): Promise<void> {
  const { port, dataDir } = parseFlags();
  const token = process.env[TOKEN_ENV] ?? "";
  if (token === "") die(`${TOKEN_ENV} is not set; refusing to start without a per-launch token`);

  const mode = process.env["GATES_LOCAL_RUNTIME"] ?? "";
  if (mode !== "" && mode !== "discover-only") die(`GATES_LOCAL_RUNTIME must be unset or "discover-only", got "${mode}"`);
  const discoverOnly = mode === "discover-only";
  const ollamaUrl = process.env["GATES_LOCAL_OLLAMA_URL"];
  const extraOrigins = (process.env["GATES_LOCAL_ALLOWED_ORIGINS"] ?? "")
    .split(",")
    .map((o) => o.trim())
    .filter((o) => o !== "");

  let store: ThreadStore;
  try {
    mkdirSync(dataDir, { recursive: true });
    store = openThreadStore(path.join(dataDir, "threads.sqlite"));
  } catch (e) {
    die(`cannot open the thread store in ${dataDir}: ${(e as Error).message}`, 1);
  }

  const runtime = createOllamaRuntime({
    ...(ollamaUrl ? { externalBaseUrl: ollamaUrl } : {}),
    allowInstall: !discoverOnly,
  });
  const catalog = createModelCatalog(() => runtime.baseUrl());

  let server: WsServer | undefined;
  const sources = createSources({ dataDir });
  const app: App = createApp({
    store,
    sources,
    runtime,
    catalog,
    push: (channel, payload) => server?.push(channel, payload),
    log,
  });

  let stopping = false;
  const shutdown = async (why: string) => {
    if (stopping) return;
    stopping = true;
    log(`shutting down (${why})`);
    setTimeout(() => {
      log(`shutdown took over ${HARD_EXIT_MS} ms; exiting anyway`);
      process.exit(1);
    }, HARD_EXIT_MS);
    const step = async (name: string, fn: () => unknown) => {
      try {
        await fn();
      } catch (e) {
        log(`${name} failed: ${(e as Error).message}`);
      }
    };
    await step("cancel turns", () => app.shutdown());
    await step("close ws", () => server?.close());
    await step("close store", () => store.close());
    // Only an app-owned Ollama that still matches its record is stopped. In
    // discover-only mode nothing was started, so nothing is stopped either.
    if (!discoverOnly) await step("stop runtime", () => runtime.stop());
    process.exit(0);
  };
  process.stdin.on("end", () => void shutdown("stdin closed"));
  process.stdin.resume();
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));

  try {
    server = await startWsServer({
      port,
      token,
      allowedOrigins: [...DEFAULT_ORIGINS, ...extraOrigins],
      handlers: app.handlers,
      log: (line) => log(`ws ${line}`),
    });
  } catch (e) {
    store.close();
    die(`cannot listen on 127.0.0.1:${port}: ${(e as Error).message}`, 1);
  }
  if (stopping) return;
  process.stdout.write(`${JSON.stringify({ ready: true, port: server.port })}\n`);
  log(`listening on 127.0.0.1:${server.port}; data in ${dataDir}; runtime ${discoverOnly ? "discover-only" : "managed"}`);

  // In the background: a failure lands in runtime status, never kills the server.
  const bring = discoverOnly ? runtime.discover() : runtime.ensure();
  bring.then(
    (s) => log(`runtime ${s.state} (${s.owner}) at ${s.baseUrl}${s.detail ? `: ${s.detail}` : ""}`),
    (e: unknown) => log(`runtime check failed: ${(e as Error).message}`),
  );
}

void main();
