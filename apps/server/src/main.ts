// CLI entry the Electron supervisor spawns (contract: apps/desktop/README.md):
//   <electron or node> apps/server/src/main.ts --port <n> --data-dir <dir>
// with the per-launch token in GATES_LOCAL_SERVER_TOKEN. Prints one
// `{"ready":true,"port":<n>}` line on stdout once the socket listens; every
// log goes to stderr. Exits on stdin EOF (parent death), SIGTERM and SIGINT.
//
// Knobs (environment):
//   GATES_LOCAL_ALLOWED_ORIGINS  comma list added to the dev web origins (the desktop app sets it)
//   GATES_LOCAL_OLLAMA_URL       treat this URL (http://127.0.0.1:<port>) as the system Ollama, and
//                                its port as the first of the app's own ports; discover-only
//                                (never install, start or stop one). Settings › Runtime still
//                                applies: "app" first tries the copy this data dir's ownership
//                                record names, at its recorded port, then the pinned port and
//                                the nine after it, as it does on 11435..11444 without a pin
//   GATES_LOCAL_RUNTIME          "discover-only": never install, start or stop Ollama (tests)
//   GATES_LOCAL_OLLAMA_BINARY    "none": never look for an Ollama binary (app install, PATH), as on
//                                a machine with none, so tests do not depend on the host
//   GATES_LOCAL_NVIDIA_SMI       the nvidia-smi command the fit check runs (tests point it at
//                                test/fake-ollama/nvidia-smi.ts; on Windows a .ts/.js script
//                                runs through this Node or Electron); default "nvidia-smi"
//   GATES_LOCAL_MEMINFO          the meminfo file the fit check reads; default /proc/meminfo
//   GATES_LOCAL_UPDATE_TEST_ROOT tests: the update check refuses to run git or pnpm in any folder
//                                outside this one (src/update/guard.ts); the e2e stack sets it
//
// The phone listener (off unless GATES_LOCAL_WEB_LISTEN is set; src/web/):
//   GATES_LOCAL_WEB_LISTEN       unix:<absolute path> for a second listener Tailscale Serve proxies
//                                to (`tailscale serve --bg --https=8456 unix:<path>`); same handlers
//                                and pushes, no token. The socket is 0600 in a 0700 directory of
//                                this user's (made if missing), so only this user and root's
//                                tailscaled can open it; TCP values are refused
//   GATES_LOCAL_WEB_ORIGIN       the exact public origin, e.g. https://hub.example.ts.net:8456
//   GATES_LOCAL_WEB_USER         the one Tailscale-User-Login value admitted
//   GATES_LOCAL_WEB_ROOT         the built web client to serve (apps/web/dist)
//   GATES_LOCAL_WEB_PEERS        optional comma list of the phones' Tailscale addresses; when set,
//                                only those sources (Serve's X-Forwarded-For) are admitted
// Serve stamps the owner's login on any dial from this machine to its own
// Tailscale address, so a source that is one of this machine's addresses is
// always refused. PEERS also covers what that check cannot see, such as a
// userspace-networking tailscaled where no interface carries the address.
// With LISTEN set, a missing or malformed other knob stops the start (exit 2).
import { execFile } from "node:child_process";
import { mkdirSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { parseArgs } from "node:util";
import { createApp, type App } from "./app.ts";
import { createModelServices, type ModelServices } from "./runtime/services.ts";
import { createSources } from "./sources/index.ts";
import { openThreadStore, type ThreadStore } from "./threads/store.ts";
import { startWsServer, type WsServer } from "./ws/server.ts";
import { createGpuLease } from "./gpu/lease.ts";
import { createImageModule } from "./image/module.ts";
import { phoneConfig } from "./web/config.ts";
import { createUpdateModule } from "./update/module.ts";
import { realRunner } from "./update/run.ts";

/** The clone this server runs from (apps/server/src -> the repo root), for Settings › Updates. */
const REPO_ROOT = path.resolve(import.meta.dirname, "..", "..", "..");

const TOKEN_ENV = "GATES_LOCAL_SERVER_TOKEN";
/** The supervisor SIGKILLs at 3 s; exit before that whatever hangs. */
const HARD_EXIT_MS = 2500;

// The Vite dev client. The desktop app serves the built client on
// gates-local://app and adds that origin through GATES_LOCAL_ALLOWED_ORIGINS
// (apps/desktop/src/main.ts), so a file:// page never gets in.
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
  const phoneResult = phoneConfig(process.env);
  if (!phoneResult.ok) die(phoneResult.message);
  const phone = phoneResult.value;

  const mode = process.env["GATES_LOCAL_RUNTIME"] ?? "";
  if (mode !== "" && mode !== "discover-only") die(`GATES_LOCAL_RUNTIME must be unset or "discover-only", got "${mode}"`);
  const binary = process.env["GATES_LOCAL_OLLAMA_BINARY"] ?? "";
  if (binary !== "" && binary !== "none") die(`GATES_LOCAL_OLLAMA_BINARY must be unset or "none", got "${binary}"`);
  // A pinned Ollama URL stands in for the system Ollama, and its port is the
  // first app port. "app" mode still tries the copy this data dir's ownership
  // record names first, at whatever port it recorded, then scans the pinned
  // port and the nine after it. So a pin keeps every probe off 11434..11444
  // only with a fresh data dir and a pinned span clear of them, as the e2e
  // runs have. It is also discover-only: the app never installs, starts or
  // stops an Ollama when the URL names the one to use.
  const ollamaUrl = process.env["GATES_LOCAL_OLLAMA_URL"];
  let pinned: URL | undefined;
  if (ollamaUrl) {
    try {
      pinned = new URL(ollamaUrl);
    } catch {
      die(`GATES_LOCAL_OLLAMA_URL is not a URL: ${ollamaUrl}`);
    }
  }
  const discoverOnly = mode === "discover-only" || pinned !== undefined;
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

  const smiCommand = process.env["GATES_LOCAL_NVIDIA_SMI"];
  const meminfoPath = process.env["GATES_LOCAL_MEMINFO"];
  // Windows runs no #! line: a script there (the tests' fake) goes through this runtime.
  const [smiFile, smiPre] =
    smiCommand !== undefined && process.platform === "win32" && /\.[cm]?[jt]s$/.test(smiCommand) ? [process.execPath, [smiCommand]] : [smiCommand, []];
  const fit = {
    ...(smiFile
      ? {
          // A called-off fit (shutdown, a runtime switch) kills the child.
          runNvidiaSmi: (args: readonly string[], signal?: AbortSignal) =>
            new Promise<string>((resolve, reject) =>
              execFile(smiFile, [...smiPre, ...args], { timeout: 10_000, windowsHide: true, ...(signal ? { signal } : {}) }, (error, stdout) => (error ? reject(error) : resolve(stdout))),
            ),
        }
      : {}),
    ...(meminfoPath ? { readMeminfo: (signal?: AbortSignal) => readFile(meminfoPath, { encoding: "utf8", ...(signal ? { signal } : {}) }) } : {}),
  };

  let server: WsServer | undefined;
  // One lease for the process: chat turns and loads share it, image jobs hold it alone.
  const gpuLease = createGpuLease();
  let services: ModelServices;
  try {
    services = await createModelServices({
      dataDir,
      push: (channel, payload) => server?.push(channel, payload),
      runtime: {
        ...(pinned ? { externalBaseUrl: pinned.origin, appPort: Number(pinned.port || 80) } : {}),
        ...(discoverOnly ? { allowInstall: false, allowStart: false } : {}),
        ...(binary === "none" ? { searchBinary: false } : {}),
      },
      // Tests point the GPU and memory reads at fakes; the GPU status and every fit use them.
      fit,
      lease: gpuLease,
      log,
    });
  } catch (e) {
    store.close();
    die(`cannot open settings in ${dataDir}: ${(e as Error).message}`, 1);
  }
  const { runtime, catalog } = services;
  const image = createImageModule({
    dataDir, store, lease: gpuLease,
    log: (line) => log(`image ${line}`),
    push: (channel, payload) => server?.push(channel, payload),
    settings: () => services.settings.get(),
    appLoadedModels: () => services.loader.appLoadedModels(),
    // The loader forgets a model the image module unloaded (keep_alive 0).
    onModelUnloaded: (model) => services.loader.prune(services.loader.appLoadedModels().filter((m) => m !== model)),
    ollamaUrl: () => runtime.baseUrl(),
  });
  const sources = createSources({ dataDir, log: (line) => log(`sources ${line}`) });
  // Reads the last update's result file and nothing else at start; git runs only on update.check.
  const update = createUpdateModule({
    root: REPO_ROOT,
    dataDir,
    runner: realRunner,
    everyChange: () => services.settings.get().updateEveryChange === true,
    log: (line) => log(`update ${line}`),
  });
  const app: App = createApp({
    update,
    image,
    lease: gpuLease,
    store,
    sources,
    settings: services.settings,
    // A turn that does not say runs tools when Settings has them on.
    toolsEnabled: () => services.settings.get().tools,
    // discover-only never starts Ollama: runtime Retry looks again without starting one
    runtime: discoverOnly
      ? { status: () => runtime.status(), baseUrl: () => runtime.baseUrl(), onChange: (l) => runtime.onChange(l), ensure: () => runtime.discover() }
      : runtime,
    catalog,
    fit,
    push: (channel, payload) => server?.push(channel, payload),
    models: services,
    log,
  });

  let stopping = false;
  const shutdown = async (why: string) => {
    if (stopping) return;
    stopping = true;
    log(`shutting down (${why})`);
    setTimeout(() => {
      log(`shutdown took over ${HARD_EXIT_MS} ms; exiting anyway`);
      services.killRuntimeNow();
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
    // A cold preload holds a shared GPU claim for minutes; image.close() needs the GPU alone.
    await step("drain model loads", () => services.loader.close());
    await step("close image module", () => image.close());
    await step("close ws", () => server?.close());
    await step("close store", () => store.close());
    // Only an app-owned Ollama this process started (and that still matches
    // its record) is stopped. In discover-only mode nothing was started.
    await step("close models", () => services.close({ stopRuntime: !discoverOnly }));
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
      onClientCount: (n) => services.gpu.clientsChanged(n),
      dataDir,
      log: (line) => log(`ws ${line}`),
      ...(phone === null ? {} : { phone }),
    });
  } catch (e) {
    store.close();
    const where = phone === null ? `127.0.0.1:${port}` : `127.0.0.1:${port} and unix:${phone.socketPath}`;
    die(`cannot listen on ${where}: ${(e as Error).message}`, 1);
  }
  if (stopping) return;
  process.stdout.write(`${JSON.stringify({ ready: true, port: server.port })}\n`);
  log(`listening on 127.0.0.1:${server.port}; data in ${dataDir}; runtime ${discoverOnly ? "discover-only" : "managed"}`);
  if (phone !== null) log(`phone listener on unix:${String(server.phoneSocket)} for ${phone.origin}, serving ${phone.webRoot}`);

  // In the background: a failure lands in runtime status, never kills the server.
  const bring = discoverOnly ? runtime.discover() : runtime.ensure();
  bring.then(
    (s) => log(`runtime ${s.state} (${s.owner}) at ${s.baseUrl}${s.detail ? `: ${s.detail}` : ""}`),
    (e: unknown) => log(`runtime check failed: ${(e as Error).message}`),
  );
}

void main();
