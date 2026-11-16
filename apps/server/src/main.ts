import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { createApp, type App } from "./app.ts";
import { createGpuBaseline } from "./fit/baseline.ts";
import { createShellStatus } from "./chat/shell.ts";
import { probeSandbox } from "@gates-local/harness/sandbox";
import { createNvidiaSmiRunner, parseMemTotal } from "./fit/gpu.ts";
import { OLLAMA_REGISTRY } from "./runtime/registry-size.ts";
import { chatList, useChatList } from "./runtime/chat-list.ts";
import { boundedGet } from "@gates-local/update/installed/feed";
import { createModelLists } from "./update/installed/models-list.ts";
import { createModelServices, type ModelServices } from "./runtime/services.ts";
import { createSources } from "./sources/index.ts";
import { createImportActivity, withImportAdmission } from "./sources/activity.ts";
import { createLibraryImports, type ImportsDeps } from "./sources/imports.ts";
import { DatabaseSync } from "node:sqlite";
import { openThreadStore, type ThreadStore } from "./threads/store.ts";
import { copyBeforeMigration } from "./threads/copies.ts";
import { SETTINGS_FILE_NAME } from "./settings/store.ts";
import { startWsServer, type WsServer } from "./ws/server.ts";
import type { Payload } from "@gates-local/contracts";
import { createGpuLease } from "./gpu/lease.ts";
import { createImageModule, type ImageModule } from "./image/module.ts";
import { engineFor, engineKnob, engineOffered, type EngineKnob } from "./image/engine.ts";
import { LINUX_ENGINE, linuxBuild, linuxPinned } from "./image/linux-build.ts";
import { createOwnComfy, freePort, writeDevice } from "./image/own.ts";
import { createImageSetup, type ImageSetupModule } from "./image/setup.ts";
import type { ComfyService } from "./image/service.ts";
import { createPicturesModule } from "./pictures/handlers.ts";
import { makeThumbnail } from "./pictures/thumbs.ts";
import { fetchFrom } from "./image/download.ts";
import { imageOffLine, imageToolChoice } from "./image/presets.ts";
import { phoneConfig } from "./web/config.ts";
import { createUpdateModule } from "./update/module.ts";
import { INSTALLED_VERSION_ENV, installedFeed, parseRestart, RESTART_ENV } from "@gates-local/update/installed/copy";
import { chooseUpdateModule, createInstalledUpdateModule } from "./update/installed/module.ts";
import { automaticChecks } from "./update/automatic.ts";
import { createUpdateAdmission } from "@gates-local/update/admission";
import { STARTUP_TOKEN_ENV } from "@gates-local/update/startup";
import { readTransaction, transactionFile } from "@gates-local/update/installed/transaction";
import { realRunner } from "@gates-local/update/run";
import { createUsage } from "./usage/index.ts";
import { createVoiceModule } from "./voice/module.ts";
import { createServerShutdown } from "./shutdown.ts";
import { interruptedWork } from "./update/activity.ts";

const CLONE_ROOT = path.resolve(import.meta.dirname, "..", "..", "..");
const TEST_BUILD_MARKER = path.resolve(import.meta.dirname, "..", "test-build.json");

const TOKEN_ENV = "GATES_LOCAL_SERVER_TOKEN";

const NO_UNIT: ComfyService = {
  inspect: async () => ({ present: false, active: false, activeState: "inactive", pid: 0 }),
  start: async () => { throw new Error("No ComfyUI unit in tests."); },
  stop: async () => {},
};

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
  const exitsAt = process.env[INSTALLED_VERSION_ENV] ?? "";
  if (exitsAt !== "" && existsSync(TEST_BUILD_MARKER) && process.env["GATES_LOCAL_UPDATE_TEST_FAULT"] === `server-exits@${exitsAt}`) die("test fault: server-exits", 1);

  const mode = process.env["GATES_LOCAL_RUNTIME"] ?? "";
  if (mode !== "" && mode !== "discover-only") die(`GATES_LOCAL_RUNTIME must be unset or "discover-only", got "${mode}"`);
  const binary = process.env["GATES_LOCAL_OLLAMA_BINARY"] ?? "";
  if (binary !== "" && binary !== "none") die(`GATES_LOCAL_OLLAMA_BINARY must be unset or "none", got "${binary}"`);
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
  const registryKnob = process.env["GATES_LOCAL_OLLAMA_REGISTRY"]?.trim();
  const modelRegistry = registryKnob === "off" ? undefined : registryKnob || (pinned === undefined && mode !== "discover-only" ? OLLAMA_REGISTRY : undefined);
  const extraOrigins = (process.env["GATES_LOCAL_ALLOWED_ORIGINS"] ?? "")
    .split(",")
    .map((o) => o.trim())
    .filter((o) => o !== "");

  let store: ThreadStore;
  try {
    mkdirSync(dataDir, { recursive: true });
    store = openThreadStore(path.join(dataDir, "threads.sqlite"));
  } catch (e) {
    // why: the person reads the message; the log line above keeps the raw cause
    if (e instanceof Error && e.cause instanceof Error) log(`thread store: ${e.cause.message}`);
    die(`cannot open the thread store in ${dataDir}: ${(e as Error).message}`, 1);
  }

  const smiCommand = process.env["GATES_LOCAL_NVIDIA_SMI"];
  const meminfoPath = process.env["GATES_LOCAL_MEMINFO"];
  const downloadOrigin = process.env["GATES_LOCAL_IMAGE_DOWNLOAD_ORIGIN"];
  let engineTest: EngineKnob | undefined;
  let offered = false;
  try {
    engineTest = engineKnob(process.env["GATES_LOCAL_IMAGE_ENGINE"]);
    offered = engineOffered(process.env["GATES_LOCAL_OFFER_ENGINE"]);
  } catch (e) { store.close(); die((e as Error).message); }
  const comfyDefault = engineTest?.address ?? process.env["GATES_LOCAL_COMFY_URL"];
  // external: Windows runs no #! line, so a script goes through this runtime
  const [smiFile, smiPre] =
    smiCommand !== undefined && process.platform === "win32" && /\.[cm]?[jt]s$/.test(smiCommand) ? [process.execPath, [smiCommand]] : [smiCommand, []];
  const fit = {
    ...(smiFile
      ? {
          runNvidiaSmi: createNvidiaSmiRunner(smiFile, smiPre),
        }
      : {}),
    ...(meminfoPath ? { readMeminfo: (signal?: AbortSignal) => readFile(meminfoPath, { encoding: "utf8", ...(signal ? { signal } : {}) }) } : {}),
    baseline: createGpuBaseline(),
  };

  let server: WsServer | undefined;
  const installedVersion = process.env[INSTALLED_VERSION_ENV] ?? "";
  const testBuild = existsSync(TEST_BUILD_MARKER);
  const startupToken = installedVersion === "" ? "" : process.env[STARTUP_TOKEN_ENV] ?? "";
  const admission = createUpdateAdmission({ finishing: startupToken !== "" });
  const gpuLease = createGpuLease();
  let services: ModelServices;
  let fitTable: App["fitTable"] | undefined;
  let imageModule: ImageModule | undefined;
  try {
    services = await createModelServices({
      imagePid: () => imageModule?.engine().pid,
      admit: admission.admit,
      dataDir,
      push: (channel, payload, changes) => {
        server?.push(channel, payload, changes);
        if (channel === "gpu.changed") fitTable?.changed();
        if (channel === "models.load") fitTable?.load(payload as Payload<"models.load">);
      },
      ...(modelRegistry === undefined ? {} : { modelRegistry }),
      runtime: {
        ...(pinned ? { externalBaseUrl: pinned.origin, appPort: Number(pinned.port || 80) } : {}),
        ...(discoverOnly ? { allowInstall: false, allowStart: false } : {}),
        ...(binary === "none" ? { searchBinary: false } : {}),
      },
      fit,
      lease: gpuLease,
      log,
    });
  } catch (e) {
    store.close();
    die(`cannot open settings in ${dataDir}: ${(e as Error).message}`, 1);
  }
  const { runtime, catalog } = services;
  const own = createOwnComfy({ appDataDir: dataDir, port: await freePort(), extraModels: () => services.settings.get().imageFolder, ...engineTest ? { address: engineTest.address } : {} });
  let imageSetup: ImageSetupModule | undefined;
  const image = createImageModule({
    admit: admission.admit,
    dataDir, store, lease: gpuLease,
    log: (line) => log(`image ${line}`),
    push: (channel, payload, changes) => {
      imageSetup?.saw(channel, payload);
      server?.push(channel, payload, changes);
    },
    own,
    ...engineTest ? { service: NO_UNIT } : {},
    thumbnail: (jobId, png) => makeThumbnail(dataDir, jobId, png),
    settings: () => services.settings.get(),
    onSettings: (listener) => { services.settings.onChange(listener); },
    memory: services.memory,
    gpuStatus: () => services.gpu.read(),
    memTotal: async () => meminfoPath ? parseMemTotal(await readFile(meminfoPath, "utf8")) : os.totalmem(),
    ...(fit.runNvidiaSmi ? { runNvidiaSmi: fit.runNvidiaSmi } : {}),
    ...(downloadOrigin ? { download: { fetch: fetchFrom(downloadOrigin), records: false } } : {}),
    ...(comfyDefault ? { defaultUrl: comfyDefault } : {}),
  });
  imageModule = image;
  services.bindEngine(image);
  imageSetup = createImageSetup({
    appDataDir: dataDir, own, image,
    engine: (gpuName) => {
      if (engineTest === undefined && !offered) return process.arch === "x64" && (process.platform === "win32" || process.platform === "linux") ? "later" : undefined;
      if (engineTest?.build !== undefined) return linuxBuild({ appDataDir: dataDir, pins: { ...engineTest.build } });
      const pick = engineTest ?? engineFor(process.platform, process.arch, gpuName);
      if (pick !== undefined) return pick.manifest.verified ? { kind: "archive", manifest: pick.manifest, layout: pick.layout } : "later";
      if (process.platform !== "linux" || process.arch !== "x64") return undefined;
      return linuxPinned(LINUX_ENGINE) ? linuxBuild({ appDataDir: dataDir, pins: LINUX_ENGINE }) : "later";
    },
    gpuStatus: () => services.gpu.read(),
    settingsAddress: () => services.settings.get().comfyUrl,
    pickedFolder: () => services.settings.get().imageFolder,
    push: (channel, payload) => server?.push(channel, payload),
    setDevice: (device) => writeDevice(dataDir, device),
    log: (line) => log(`image setup ${line}`),
  });
  const imports = createImportActivity(admission);
  const sources = withImportAdmission(createSources({ dataDir, log: (line) => log(`sources ${line}`) }), imports);
  const libraryImports = createLibraryImports({ ...options.imports, sources, activity: imports });
  const activity = () => interruptedWork({
    imports: [...imports.activity(), ...libraryImports.activity()],
    turns: app.activeTurns(),
    downloads: services.pulls.pending().map((p) => p.name),
    imageJobs: image.activeJobs?.() ?? 0,
  });
  const uninterruptible = () => [...imports.activity(), ...libraryImports.activity()];
  const update = chooseUpdateModule(process.env, {
    installed: (version) => {
      const feed = installedFeed(process.env, { testBuild, log: (line) => log(`update ${line}`) });
      return createInstalledUpdateModule({
        version,
        platform: process.platform,
        arch: process.arch,
        feed,
        dataDir,
        models: createModelLists({
          dataDir, base: feed.base, keys: feed.keys, get: boundedGet({ allowLoopbackHttp: feed.allowLoopbackHttp }),
          inUse: chatList, use: useChatList, log: (line) => log(`update ${line}`),
        }),
        automatic: {
          enabled: () => services.settings.get().updateAutomatic !== false,
          onChange: (listener) => services.settings.onChange((next, previous) => {
            if (next.updateAutomatic !== previous.updateAutomatic) listener();
          }),
        },
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
        changed: (status, change) => server?.push("update.changed", status, [change]),
        log: (line) => log(`update ${line}`),
      });
    },
    clone: () => createUpdateModule({
      admission,
      root: CLONE_ROOT,
      dataDir,
      runner: realRunner,
      everyChange: () => services.settings.get().updateEveryChange === true,
      onEveryChange: (listener) => services.settings.onChange((next, previous) => {
        if ((next.updateEveryChange === true) !== (previous.updateEveryChange === true)) listener();
      }),
      changed: (status, change) => server?.push("update.changed", status, [change]),
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
    imageSetup,
    lease: gpuLease,
    memory: services.memory,
    store,
    sources,
    settings: services.settings,
    toolsEnabled: () => services.settings.get().tools,
    shellStatus: createShellStatus(probeSandbox, (line) => log(line)),
    imageTool: () => {
      const settings = services.settings.get();
      return imageToolChoice({ ...settings, imageChoice: settings.imageChoice ?? image.defaultChoice() }, image.runnable());
    },
    imageOff: (toolsOn) => imageOffLine(services.settings.get(), image.runnable(), toolsOn),
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
      allowedOrigins: [...DEFAULT_ORIGINS, ...extraOrigins],
      handlers: { ...app.handlers, ...usage.handlers, ...createVoiceModule({ settings: () => services.settings.get() }).handlers, ...pictures.handlers },
      thumbnails: (jobId) => app.thumbnail(jobId),
      onClientCount: (n) => services.gpu.clientsChanged(n),
      onWindowGone: (window) => app.windowGone(window),
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

  const bring = discoverOnly ? runtime.discover() : runtime.ensure();
  bring.then(
    (s) => log(`runtime ${s.state} (${s.owner}) at ${s.baseUrl}${s.detail ? `: ${s.detail}` : ""}`),
    (e: unknown) => log(`runtime check failed: ${(e as Error).message}`),
  );
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) void main();
