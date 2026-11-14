// Fake ComfyUI on an ephemeral port, CPU-only unless gpu() is called. The real
// client polls history; the WebSocket upgrade stays open and sends nothing but
// the progress frames a test asks for with progress().
// Its file list is FLUX.2 Klein 4B's (the Fast default) unless withApp(), only() or bare()
// says otherwise; missing() drops every diffusion model, so no built-in setup can run.
// gpu(): /system_stats names a CUDA device, so the image fit runs and Image mode's default runs
// on Klein's files (on the CPU the default needs the FP4 encoder they lack). Use it only with the e2e stack, whose server reads the
// fake nvidia-smi (GATES_LOCAL_NVIDIA_SMI), never the real one.
// withFolders(): it names model folders of its own (under ~/.cache, never a real ComfyUI's) and
// lists what a download put in their gates-local/ folders. It also serves every Hugging Face
// path the app downloads from (the e2e stack points GATES_LOCAL_IMAGE_DOWNLOAD_ORIGIN here):
// a few MiB per file, with Range, trickled and never finished while slowDownloads(true).
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type ServerResponse } from "node:http";
import { homedir } from "node:os";
import path from "node:path";
import type { Duplex } from "node:stream";
import { APP_FILES, comfyInfo, KLEIN_FILES, type FakeFiles } from "../../apps/server/test/comfy/info.ts";
import type { FakeEngine } from "./fixtures.ts";

const KINDS = ["checkpoints", "loras", "diffusion_models", "text_encoders", "vae"] as const;
const ENGINE_PATH = "/engine/comfyui.tar.gz";
/**
 * The fake engine's run: it tells the fake it is up (with the arguments the app gave main.py),
 * stays until the app stops it, then tells the fake it is down.
 */
const FAKE_ENGINE_SCRIPT = `const [address, ...args] = process.argv.slice(2);
const tell = (state, body) => fetch(address + "/__engine/" + state, { method: "POST", body: JSON.stringify(body ?? []) }).catch(() => {});
await tell("up", args);
const end = async () => { await tell("down"); process.exit(0); };
process.on("SIGTERM", end);
process.on("SIGINT", end);
setInterval(() => {}, 60_000);
`;
/** Each served file's size: enough for a progress bar to move. */
const FILE_BYTES = 4 * 1024 * 1024;

export async function fakeComfy() {
  let complete = false, missingModel = false, cuda = false, unlisted = false, down = false;
  /** The file sets /object_info lists, besides what a download put in its folders. */
  let listed: readonly FakeFiles[] = [KLEIN_FILES];
  const lists = () => missingModel ? listed.map((f) => ({ ...f, diffusion_models: [] })) : listed;
  /** folders: where it lists models from; made: the folder withFolders() made, removed at close. */
  let folders: string | undefined, made: string | undefined, slow = false, slowFile: string | undefined;
  /** What /view serves: a 1×1 PNG unless a test set a picture of its own. */
  let viewPng: Buffer = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64");
  /** engine(): the fake engine's tar.gz, its folder, and the arguments its last run started with. */
  let engineArchive: Buffer | undefined, engineDir: string | undefined, engineArgs: string[] | undefined;
  /** Held downloads: each ends its response when released. */
  const held = new Set<() => void>();
  /** A held GET trickles 16 KiB every 100 ms, never the last piece, until released or the app stops it. */
  const serveFile = (method: string, range: string | undefined, name: string, res: ServerResponse) => {
    const body = Buffer.alloc(FILE_BYTES, name);
    const from = Number(/^bytes=(\d+)-$/.exec(range ?? "")?.[1] ?? 0);
    const part = body.subarray(from);
    res.writeHead(from > 0 ? 206 : 200, { "content-length": String(method === "HEAD" ? body.length : part.length), ...from > 0 ? { "content-range": `bytes ${from}-${body.length - 1}/${body.length}` } : {} });
    if (method === "HEAD") { res.end(); return; }
    if (!slow || (slowFile !== undefined && name !== slowFile)) { res.end(part); return; }
    let sent = 0;
    const tick = setInterval(() => {
      const next = Math.min(sent + 16 * 1024, part.length - 1);
      if (next > sent) { res.write(part.subarray(sent, next)); sent = next; }
    }, 100);
    const release = () => { clearInterval(tick); held.delete(release); res.end(part.subarray(sent)); };
    held.add(release);
    res.on("close", () => { clearInterval(tick); held.delete(release); });
  };
  /** What a download put in the gates-local/ folders, as ComfyUI lists it. */
  const downloaded = (): FakeFiles => folders === undefined ? {} : Object.fromEntries(KINDS.map((kind) => {
    const dir = path.join(folders!, kind, "gates-local");
    return [kind, existsSync(dir) ? readdirSync(dir).filter((f) => !f.endsWith(".part")).map((f) => `gates-local/${f}`) : []];
  }));
  let n = 0;
  const active = new Set<string>();
  const completed = new Set<string>();
  const runs: { id: string; startedAt: number; endedAt?: number }[] = [];
  /** Each /prompt body as sent: the graph the server built for a job. */
  const prompts: { prompt: Record<string, { class_type: string; inputs: Record<string, unknown> }> }[] = [];
  const sockets = new Set<Duplex>();
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const url = new URL(req.url ?? "/", "http://fake");
    if (url.pathname.includes("/resolve/")) { serveFile(req.method ?? "GET", req.headers.range, path.basename(url.pathname), res); return; }
    if (url.pathname === ENGINE_PATH && engineArchive !== undefined) { res.writeHead(200, { "content-length": String(engineArchive.length) }); res.end(engineArchive); return; }
    if (url.pathname === "/__engine/up") {
      down = false; engineArgs = JSON.parse(Buffer.concat(chunks).toString("utf8") || "[]") as string[];
      // as ComfyUI does: started with --base-directory, its model folders are that folder's models/
      const base = engineArgs[engineArgs.indexOf("--base-directory") + 1];
      if (engineArgs.includes("--base-directory") && base !== undefined) folders = path.join(base, "models");
      res.end("{}"); return;
    }
    if (url.pathname === "/__engine/down") { down = true; res.end("{}"); return; }
    if (down) { res.writeHead(503); res.end("{}"); return; }
    let body: unknown = {};
    switch (url.pathname) {
      case "/system_stats": body = { system: {}, devices: [cuda ? { type: "cuda", torch_vram_total: 0 } : { type: "cpu" }] }; break;
      case "/object_info": if (unlisted) { res.writeHead(500); res.end("{}"); return; } body = comfyInfo(...lists(), downloaded()); break;
      case "/internal/folder_paths": body = folders === undefined ? {} : Object.fromEntries(KINDS.map((kind) => [kind, [path.join(folders!, kind)]])); break;
      case "/prompt": {
        const id = `p${++n}`; active.add(id); runs.push({ id, startedAt: Date.now() });
        prompts.push(JSON.parse(Buffer.concat(chunks).toString("utf8")));
        body = { prompt_id: id }; break;
      }
      case "/queue": body = { queue_running: [...active].map(id => [1, id]), queue_pending: [] }; break;
      case "/interrupt": active.clear(); break;
      case "/view":
        res.writeHead(200, { "content-type": "image/png" });
        res.end(viewPng); return;
      default:
        if (url.pathname.startsWith("/history/") && (complete || completed.has(url.pathname.slice("/history/".length)))) {
          const id = url.pathname.slice("/history/".length); active.delete(id);
          const run = runs.find((entry) => entry.id === id);
          if (run) run.endedAt ??= Date.now();
          body = { [id]: { outputs: { "8": { images: [{ filename: "ship.png" }] } } } };
        }
    }
    res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify(body));
  });
  server.on("upgrade", (req, socket) => {
    // The backend may reset its preview connection when it exits on restart.
    // This test-owned peer disconnect is expected; unrelated faults still fail.
    socket.on("error", (error: NodeJS.ErrnoException) => {
      if (error.code !== "ECONNRESET") throw error;
    });
    const key = req.headers["sec-websocket-key"];
    if (!key) { socket.destroy(); return; }
    const accept = createHash("sha1").update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest("base64");
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
    sockets.add(socket); socket.on("close", () => sockets.delete(socket));
    socket.on("data", () => {});
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("fake ComfyUI did not bind");
  const url = `http://127.0.0.1:${address.port}`;
  return {
    url,
    state: () => runs.map((run) => ({ ...run })),
    prompts: () => prompts.map((p) => p.prompt),
    /** Serve this PNG for every finished prompt from now on. */
    picture: (png: Buffer) => { viewPng = png; },
    /** List every built-in setup's files: Klein, its compact encoder, Z-Image int8 and MOSS-Image. */
    withApp: () => { listed = APP_FILES; },
    /** List these file sets and nothing else. */
    only: (...files: FakeFiles[]) => { listed = files; },
    /** List none of the built-in setups' files: each offers its download. */
    bare: () => { listed = []; },
    /** Report a CUDA device: the image fit then measures the (fake) GPU. */
    gpu: () => { cuda = true; },
    /** Send a progress frame for the newest running prompt to every open socket. */
    progress: (value: number, max: number) => {
      const id = [...active].at(-1);
      if (id === undefined) throw new Error("no prompt is running");
      const payload = Buffer.from(JSON.stringify({ type: "progress", data: { prompt_id: id, value, max } }));
      if (payload.length > 125) throw new Error("progress frame too long for a one-byte length");
      for (const socket of sockets) socket.write(Buffer.concat([Buffer.from([0x81, payload.length]), payload]));
    },
    /**
     * Say the newest running prompt is executing its first node of this class (as ComfyUI's
     * `executing` frame names it, by node id), as a real run does before each node.
     */
    executing: (classType: string) => {
      const id = [...active].at(-1);
      if (id === undefined) throw new Error("no prompt is running");
      const graph = prompts.at(-1)?.prompt ?? {};
      const node = Object.entries(graph).find(([, entry]) => entry.class_type === classType)?.[0];
      if (node === undefined) throw new Error(`the graph has no ${classType}`);
      const payload = Buffer.from(JSON.stringify({ type: "executing", data: { node, prompt_id: id } }));
      if (payload.length > 125) throw new Error("executing frame too long for a one-byte length");
      for (const socket of sockets) socket.write(Buffer.concat([Buffer.from([0x81, payload.length]), payload]));
    },
    /** Fail /object_info (on) or answer it again (off): the app then has never read the file list. */
    unlisted: (on: boolean) => { unlisted = on; },
    /** Answer nothing but 503 (on), as a ComfyUI that is not running; downloads are still served. */
    down: (on: boolean) => { down = on; },
    /** Name model folders of its own, empty, and list what downloads put there. */
    withFolders: () => {
      const root = path.join(homedir(), ".cache", "gates-local-e2e");
      mkdirSync(root, { recursive: true });
      folders = made = mkdtempSync(path.join(root, "comfy-models-"));
    },
    /** Trickle every download, or only `file`'s, and never finish it (on); off sends the rest of the held ones. */
    slowDownloads: (on: boolean, file?: string) => { slow = on; slowFile = file; if (!on) for (const release of held) release(); },
    /** With an id, finish only that prompt so a queued successor stays held. */
    finish: (id?: string) => { if (id === undefined) complete = true; else completed.add(id); },
    /**
     * The app's own ComfyUI, to set up: a tar.gz laid out as the Linux engine (venv/bin/python
     * beside ComfyUI/main.py) that this fake serves, and the knob the stack hands the server
     * (stack.reset's engine). Its "python" answers for this fake while it runs: up when started,
     * down when stopped. Pass the result to stack.reset; nothing is fetched from anywhere else.
     */
    engine: (): FakeEngine => {
      const root = path.join(homedir(), ".cache", "gates-local-e2e");
      mkdirSync(root, { recursive: true });
      engineDir = mkdtempSync(path.join(root, "comfy-engine-"));
      const tree = path.join(engineDir, "tree");
      mkdirSync(path.join(tree, "venv", "bin"), { recursive: true });
      mkdirSync(path.join(tree, "ComfyUI"), { recursive: true });
      writeFileSync(path.join(tree, "ComfyUI", "main.py"), "# the fake engine runs engine.mjs, not this\n");
      writeFileSync(path.join(tree, "ComfyUI", "engine.mjs"), FAKE_ENGINE_SCRIPT);
      writeFileSync(path.join(tree, "venv", "bin", "python"), `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} "$(dirname "$0")/../../ComfyUI/engine.mjs" ${JSON.stringify(url)} "$@"\n`, { mode: 0o755 });
      const out = path.join(engineDir, "comfyui.tar.gz");
      execFileSync("tar", ["-czf", out, "-C", tree, "venv", "ComfyUI"]);
      engineArchive = readFileSync(out);
      const manifest = {
        version: "0.0.0-test", url: `${url}${ENGINE_PATH}`, sha256: createHash("sha256").update(engineArchive).digest("hex"),
        sizeBytes: engineArchive.length, format: "tar.gz", verified: true, source: "test/e2e/fake-comfy.ts",
      };
      return { manifest, layout: "uv-venv", address: url };
    },
    /** The arguments the fake engine's last run started with (main.py's), or undefined if none has run. */
    engineArgs: () => engineArgs,
    missing: () => { missingModel = true; },
    restore: (finish = true) => { missingModel = false; complete = finish; },
    close: () => new Promise<void>((resolve, reject) => {
      for (const socket of sockets) socket.destroy();
      if (made !== undefined) rmSync(made, { recursive: true, force: true }); // its own, never the app's models folder
      if (engineDir !== undefined) rmSync(engineDir, { recursive: true, force: true });
      server.close(error => error ? reject(error) : resolve());
      server.closeAllConnections();
    }),
  };
}
