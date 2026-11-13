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
//   GATES_LOCAL_IMAGE_DOWNLOAD_ORIGIN tests: image model downloads fetch from this http origin on
//                                this computer, never Hugging Face (image/download.ts fetchFrom),
//                                and are checked against their pins only, not the app's records
//                                of each file's sha256; the e2e stack always sets it
//   GATES_LOCAL_UPDATE_TEST_ROOT tests: the update check refuses to run git or pnpm in any folder
//                                outside this one (src/update/guard.ts); the e2e stack sets it
//   GATES_LOCAL_INSTALLED_VERSION the packaged desktop app's version; set, Settings › Updates
//                                checks the signed release list (src/update/installed/) and the
//                                clone updater is never built, so updates start no git
//   GATES_LOCAL_UPDATE_FEED      an https release page base in place of the public one
//   GATES_LOCAL_UPDATE_TEST_KEYS test builds only (resources/test-build.json): extra release keys,
//                                and the feed may be loopback http
//   GATES_LOCAL_INSTALLED_RESTART set by the desktop app: whether this installed copy can replace
//                                its own file (yes), or why not (installed/module.ts parseRestart)
//   GATES_LOCAL_UPDATE_STARTUP_TOKEN set on an installed copy's update start: admission stays
//                                closed until the watcher's result carries this token
//   GATES_LOCAL_UPDATE_TEST_FAULT test builds only: "server-never-ready@<version>" keeps that
//                                version's server from printing ready, so an update to it goes back;
//                                first it raises the store's version by one, after the pre-migration
//                                copy, so going back has a store to restore, and adds a settings key
//                                the older version does not know
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
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { createApp, type App } from "./app.ts";
import { createShellStatus } from "./chat/shell.ts";
import { probeSandbox } from "../../../packages/harness/src/sandbox/index.ts";
import { createNvidiaSmiRunner } from "./fit/gpu.ts";
import { createModelServices, type ModelServices } from "./runtime/services.ts";
import { createSources } from "./sources/index.ts";
import { createImportActivity, withImportAdmission } from "./sources/activity.ts";
import { createLibraryImports, type ImportsDeps } from "./sources/imports.ts";
import { DatabaseSync } from "node:sqlite";
import { openThreadStore, type ThreadStore } from "./threads/store.ts";
import { copyBeforeMigration } from "./threads/copies.ts";
import { SETTINGS_FILE_NAME } from "./settings/store.ts";
import { startWsServer, type WsServer } from "./ws/server.ts";
import { ORDERED_DOMAINS, type Payload } from "@gates-local/contracts";
import { createGpuLease } from "./gpu/lease.ts";
import { createImageModule } from "./image/module.ts";
import { createPicturesModule } from "./pictures/handlers.ts";
import { makeThumbnail } from "./pictures/thumbs.ts";
import { fetchFrom } from "./image/download.ts";
import { imageToolChoice } from "./image/presets.ts";
import { phoneConfig } from "./web/config.ts";
import { createUpdateModule } from "./update/module.ts";
import { chooseUpdateModule, createInstalledUpdateModule, INSTALLED_VERSION_ENV, installedFeed, parseRestart, RESTART_ENV } from "./update/installed/module.ts";
import { automaticChecks } from "./update/automatic.ts";
import { createUpdateAdmission } from "./update/admission.ts";
import { STARTUP_TOKEN_ENV } from "./update/startup.ts";
import { readTransaction, transactionFile } from "../../desktop/src/installed-update/transaction.ts";
import { realRunner } from "./update/run.ts";
import { createUsage } from "./usage/index.ts";
import { createVoiceModule } from "./voice/module.ts";
import { createServerShutdown } from "./shutdown.ts";

/** The clone this server runs from (apps/server/src -> the repo root), for Settings › Updates. */
const REPO_ROOT = path.resolve(import.meta.dirname, "..", "..", "..");
/** The packager's marker of a test build: resources/test-build.json beside resources/server/main.mjs. */
const TEST_BUILD_MARKER = path.resolve(import.meta.dirname, "..", "test-build.json");

const TOKEN_ENV = "GATES_LOCAL_SERVER_TOKEN";
/** The supervisor SIGKILLs at 3 s; exit before that whatever hangs. */

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

export async function main(options: { imports?: Omit<ImportsDeps, "sources"> } = {}): Promise<void> {
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
    // The message is the sentence for the person. A raw cause (the call and
    // file that failed) goes to the log line above it.
    if (e instanceof Error && e.cause instanceof Error) log(`thread store: ${e.cause.message}`);
    die(`cannot open the thread store in ${dataDir}: ${(e as Error).message}`, 1);
  }

  const smiCommand = process.env["GATES_LOCAL_NVIDIA_SMI"];
  const meminfoPath = process.env["GATES_LOCAL_MEMINFO"];
  const downloadOrigin = process.env["GATES_LOCAL_IMAGE_DOWNLOAD_ORIGIN"];
  // Windows runs no #! line: a script there (the tests' fake) goes through this runtime.
  const [smiFile, smiPre] =
    smiCommand !== undefined && process.platform === "win32" && /\.[cm]?[jt]s$/.test(smiCommand) ? [process.execPath, [smiCommand]] : [smiCommand, []];
  const fit = {
    ...(smiFile
      ? {
          // A called-off fit (shutdown, a runtime switch) kills the child.
          runNvidiaSmi: createNvidiaSmiRunner(smiFile, smiPre),
        }
      : {}),
    ...(meminfoPath ? { readMeminfo: (signal?: AbortSignal) => readFile(meminfoPath, { encoding: "utf8", ...(signal ? { signal } : {}) }) } : {}),
  };

  let server: WsServer | undefined;
  const installedVersion = process.env[INSTALLED_VERSION_ENV] ?? "";
  const testBuild = existsSync(TEST_BUILD_MARKER);
  // An installed copy's update start: every write waits for the watcher's result (design section 2, "Update startup").
  const startupToken = installedVersion === "" ? "" : process.env[STARTUP_TOKEN_ENV] ?? "";
  const admission = createUpdateAdmission({ finishing: startupToken !== "" });
  // One lease for the process: chat turns and loads share it, image jobs hold it alone.
  const gpuLease = createGpuLease();
  let services: ModelServices;
  // The fit table follows the GPU watcher's readings and the loader's loads (bound once the app exists).
  let fitTable: App["fitTable"] | undefined;
  try {
    services = await createModelServices({
      admit: admission.admit,
      dataDir,
      push: (channel, payload, changes) => {
        server?.push(channel, payload, changes);
        if (channel === "gpu.changed") fitTable?.changed();
        if (channel === "models.load") fitTable?.load(payload as Payload<"models.load">);
      },
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
    admit: admission.admit,
    dataDir, store, lease: gpuLease,
    log: (line) => log(`image ${line}`),
    push: (channel, payload, changes) => server?.push(channel, payload, changes),
    thumbnail: (jobId, png) => makeThumbnail(dataDir, jobId, png),
    settings: () => services.settings.get(),
    imageMayUnload: () => services.loader.imageMayUnload(),
    // The loader forgets a model the image module unloaded (keep_alive 0).
    onModelUnloaded: (model) => services.loader.unloaded(model),
    ollamaUrl: () => runtime.baseUrl(),
    // The default and the picker's tiers read the GPU as the picker does.
    gpuStatus: () => services.gpu.read(),
    // The image fit reads the same GPU the chat fits do: a test's fake nvidia-smi, never the real one.
    ...(fit.runNvidiaSmi ? { runNvidiaSmi: fit.runNvidiaSmi } : {}),
    ...(downloadOrigin ? { download: { fetch: fetchFrom(downloadOrigin), records: false } } : {}),
  });
  const imports = createImportActivity(admission);
  const sources = withImportAdmission(createSources({ dataDir, log: (line) => log(`sources ${line}`) }), imports);
  const libraryImports = createLibraryImports({ ...options.imports, sources, activity: imports });
  // What an update would interrupt, for the approval; imports cannot be interrupted at all.
  const activity = () => [
    ...imports.activity(),
    ...libraryImports.activity(),
    ...(app.activeTurns() === 0 ? [] : [`${app.activeTurns()} running ${app.activeTurns() === 1 ? "reply" : "replies"} (including other windows)`]),
    ...services.pulls.pending().map((p) => `model download: ${p.name}`),
    ...((image.activeJobs?.() ?? 0) > 0 ? [`${image.activeJobs?.()} image generation jobs (queued or running)`] : []),
  ];
  const uninterruptible = () => [...imports.activity(), ...libraryImports.activity()];
  // One automatic checker for the supervised desktop server; browser-only servers never fetch on a timer.
  // An installed copy (the desktop app says its version) checks the signed release list instead.
  const update = chooseUpdateModule(process.env, {
    installed: (version) => createInstalledUpdateModule({
      version,
      platform: process.platform,
      arch: process.arch,
      feed: installedFeed(process.env, { testBuild, log: (line) => log(`update ${line}`) }),
      dataDir,
      automatic: {
        enabled: () => services.settings.get().updateAutomatic !== false,
        onChange: (listener) => services.settings.onChange((next, previous) => {
          if (next.updateAutomatic !== previous.updateAutomatic) listener();
        }),
      },
      // An unfinished update's download stays: the watcher proves and moves it.
      keep: () => {
        try {
          const tx = readTransaction(transactionFile(dataDir));
          return tx === null ? [] : [tx.to];
        } catch {
          return [];
        }
      },
      restart: parseRestart(process.env[RESTART_ENV]),
      admission,
      activity,
      uninterruptible,
      ...(startupToken === "" ? {} : { startupToken }),
      changed: (status) => server?.push("update.changed", status),
      log: (line) => log(`update ${line}`),
    }),
    clone: () => createUpdateModule({
      admission,
      root: REPO_ROOT,
      dataDir,
      runner: realRunner,
      everyChange: () => services.settings.get().updateEveryChange === true,
      onEveryChange: (listener) => services.settings.onChange((next, previous) => {
        if ((next.updateEveryChange === true) !== (previous.updateEveryChange === true)) listener();
      }),
      changed: (status) => server?.push("update.changed", status),
      activity,
      uninterruptible,
      log: (line) => log(`update ${line}`),
    }),
  });
  const usage = createUsage({
    file: path.join(dataDir, "usage.sqlite"),
    push: (channel, payload) => server?.push(channel, payload),
    replies: () => store.replyUsage(),
    log,
  });
  const app: App = createApp({
    usage,
    admit: admission.admit,
    dataDir,
    libraryImports,
    update,
    image,
    lease: gpuLease,
    store,
    sources,
    settings: services.settings,
    // A turn that does not say runs tools when Settings has them on.
    toolsEnabled: () => services.settings.get().tools,
    shellStatus: createShellStatus(probeSandbox, (line) => log(line)),
    // Tools › Make images: off unless switched on; an unset choice is the first preset ComfyUI has.
    imageTool: () => {
      const settings = services.settings.get();
      return imageToolChoice({ ...settings, imageChoice: settings.imageChoice ?? image.defaultChoice() });
    },
    // discover-only never starts Ollama: runtime Retry looks again without starting one
    runtime: discoverOnly
      ? { status: () => runtime.status(), baseUrl: () => runtime.baseUrl(), onChange: (l) => runtime.onChange(l), ensure: () => runtime.discover(), lookIfDown: () => runtime.lookIfDown() }
      : runtime,
    catalog,
    fit,
    push: (channel, payload, changes) => server?.push(channel, payload, changes),
    models: services,
    log,
  });
  fitTable = app.fitTable;
  // Indexes pictures made before the index, in the background; pictures.list waits for it.
  const pictures = createPicturesModule({ store, dataDir, log: (line) => log(`pictures ${line}`) });
  const stopAutomatic = automaticChecks({
    desktop: process.env["GATES_LOCAL_DESKTOP"] === "1",
    enabled: () => services.settings.get().updateAutomatic !== false,
    check: () => update.check(true),
    onChange: (listener) => services.settings.onChange((next, previous) => {
      if (next.updateAutomatic !== previous.updateAutomatic) listener();
    }),
  });

  const shutdown = createServerShutdown({
    admission, stopAutomatic, app, update, imports, loader: services.loader, image,
    server: () => server, store, log,
    models: { close: () => services.close({ stopRuntime: !discoverOnly }), killRuntimeNow: () => services.killRuntimeNow() },
  });
  process.stdin.on("end", () => void shutdown("stdin closed"));
  process.stdin.resume();
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGHUP", () => void shutdown("SIGHUP"));

  try {
    server = await startWsServer({
      port,
      token,
      ordered: ORDERED_DOMAINS,
      allowedOrigins: [...DEFAULT_ORIGINS, ...extraOrigins],
      handlers: { ...app.handlers, ...usage.handlers, ...createVoiceModule({ settings: () => services.settings.get() }).handlers, ...pictures.handlers },
      thumbnails: (jobId) => app.thumbnail(jobId),
      onClientCount: (n) => services.gpu.clientsChanged(n),
      onClientReady: (push) => app.replayTurns(push),
      dataDir,
      log: (line) => log(`ws ${line}`),
      ...(phone === null ? {} : { phone }),
    });
  } catch (e) {
    store.close();
    const where = phone === null ? `127.0.0.1:${port}` : `127.0.0.1:${port} and unix:${phone.socketPath}`;
    die(`cannot listen on ${where}: ${(e as Error).message}`, 1);
  }
  if (shutdown.stopping()) return;
  // A test build's broken version: it migrates the store the way a real
  // migration does (the copy first, then the version), and never says it is ready.
  if (testBuild && installedVersion !== "" && process.env["GATES_LOCAL_UPDATE_TEST_FAULT"] === `server-never-ready@${installedVersion}`) {
    const file = path.join(dataDir, "threads.sqlite");
    const db = new DatabaseSync(file);
    try {
      const version = Number(db.prepare("PRAGMA user_version").get()?.["user_version"]);
      copyBeforeMigration(db, file, version + 1);
      db.exec(`PRAGMA user_version = ${version + 1}`);
    } finally {
      db.close();
    }
    // And a settings key the older version does not know (design U6).
    const settingsFile = path.join(dataDir, SETTINGS_FILE_NAME);
    if (existsSync(settingsFile)) {
      const saved = JSON.parse(readFileSync(settingsFile, "utf8")) as { settings: Record<string, unknown> };
      writeFileSync(settingsFile, `${JSON.stringify({ ...saved, settings: { ...saved.settings, testFaultNewerKey: true } }, null, 2)}\n`);
    }
    log("test fault: server-never-ready");
    return;
  }
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

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) void main();
