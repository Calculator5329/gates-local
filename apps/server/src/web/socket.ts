import { type BigIntStats, lstatSync, mkdirSync, unlinkSync } from "node:fs";
import type { Server } from "node:http";
import { connect } from "node:net";
import path from "node:path";
import { acquireFileLock } from "@gates-local/update/lock";

// external: Linux sun_path is 108 bytes, the terminating NUL included
const MAX_SOCKET_PATH_BYTES = 107;

function code(e: unknown): string | undefined {
  return typeof e === "object" && e !== null ? (e as { code?: string }).code : undefined;
}

function ownUid(): number {
  if (typeof process.getuid !== "function") throw new Error("the phone socket needs a POSIX system (owner and mode checks)");
  return process.getuid();
}

function checkParent(dir: string, uid: number): void {
  let st;
  try {
    st = lstatSync(dir);
  } catch (e) {
    if (code(e) !== "ENOENT") throw e;
    try {
      mkdirSync(dir, { mode: 0o700 });
    } catch (made) {
      throw new Error(`cannot create the phone socket directory ${dir}: ${(made as Error).message}`, { cause: made });
    }
    st = lstatSync(dir);
  }
  if (!st.isDirectory()) throw new Error(`phone socket directory ${dir} is not a real directory (a link or a file)`);
  if (st.uid !== uid) throw new Error(`phone socket directory ${dir} is owned by uid ${st.uid}, not this user (${uid})`);
  if ((st.mode & 0o077) !== 0) throw new Error(`phone socket directory ${dir} has group or other access (mode ${(st.mode & 0o777).toString(8)}); it must be 0700`);
}

function answers(socketPath: string): Promise<boolean> {
  return new Promise((resolve, reject) => {
    const c = connect(socketPath);
    c.once("connect", () => {
      c.destroy();
      resolve(true);
    });
    c.once("error", (e) => {
      c.destroy();
      if (code(e) === "ECONNREFUSED") resolve(false);
      else reject(new Error(`cannot check the existing phone socket ${socketPath}: ${e.message}`));
    });
  });
}

export interface SocketTestHooks {
  readonly afterRefusedProbe?: () => Promise<void>;
  readonly afterBind?: () => Promise<void>;
}

async function clearStale(socketPath: string, uid: number, hooks: SocketTestHooks, stillOurs: () => boolean): Promise<void> {
  let st;
  try {
    st = lstatSync(socketPath, { bigint: true });
  } catch (e) {
    if (code(e) === "ENOENT") return;
    throw e;
  }
  if (!st.isSocket()) throw new Error(`${socketPath} exists and is not a socket; refusing to touch it`);
  if (st.uid !== BigInt(uid)) throw new Error(`${socketPath} is a socket owned by uid ${st.uid}, not this user; refusing to touch it`);
  if (await answers(socketPath)) throw new Error(`another server is already listening on ${socketPath}`);
  await hooks.afterRefusedProbe?.();
  // why: another start may have cleared this socket and bound its own while the probe ran
  let now;
  try {
    now = lstatSync(socketPath, { bigint: true });
  } catch (e) {
    throw new Error(`the stale socket at ${socketPath} changed while it was being checked; refusing to touch it`, { cause: e });
  }
  if (!now.isSocket() || now.uid !== st.uid || !sameFile(now, st)) {
    throw new Error(`the stale socket at ${socketPath} changed while it was being checked; refusing to touch it`);
  }
  if (await answers(socketPath)) throw new Error(`another server is already listening on ${socketPath}; refusing to remove it`);
  if (!stillOurs()) throw new Error(`phone socket lease changed: ${socketPath}; refusing to remove it`);
  const last = lstatSync(socketPath, { bigint: true });
  if (!last.isSocket() || last.uid !== st.uid || !sameFile(last, now)) throw new Error(`the stale socket at ${socketPath} changed while it was being checked; refusing to touch it`);
  unlinkSync(socketPath);
}

function sameFile(a: BigIntStats, b: BigIntStats): boolean {
  return a.dev === b.dev && a.ino === b.ino && a.ctimeNs === b.ctimeNs && a.birthtimeNs === b.birthtimeNs;
}

export async function listenOwnerSocket(server: Server, socketPath: string, hooks: SocketTestHooks = {}): Promise<void> {
  if (!path.isAbsolute(socketPath)) throw new Error(`the phone socket path must be absolute, got "${socketPath}"`);
  if (Buffer.byteLength(socketPath) > MAX_SOCKET_PATH_BYTES) throw new Error(`the phone socket path is over ${MAX_SOCKET_PATH_BYTES} bytes`);
  const uid = ownUid();
  checkParent(path.dirname(socketPath), uid);
  const acquired = acquireFileLock(`${socketPath}.lock`);
  if (!acquired.ok) throw new Error(`phone socket is locked by another starter (${acquired.pid ?? "unknown owner"}): ${socketPath}`);
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    process.off("exit", release);
    server.off("close", release);
    acquired.lock.release();
  };
  process.once("exit", release);
  server.once("close", release);
  try {
    await clearStale(socketPath, uid, hooks, acquired.lock.stillOurs);
    if (!acquired.lock.stillOurs()) throw new Error(`phone socket lease changed: ${socketPath}; refusing to bind`);
    let bound: BigIntStats | null = null;
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      // why: a umask, not a chmod after, so the socket never exists wider than 0600
      const old = process.umask(0o177);
      try {
        server.listen(socketPath, () => {
          server.off("error", reject);
          resolve();
        });
        // external: Node binds inside listen(), so this is the file it made, unless a bind
        // error is about to arrive on "error"
        bound = lstatSync(socketPath, { bigint: true, throwIfNoEntry: false }) ?? null;
      } finally {
        process.umask(old);
      }
    });
    await hooks.afterBind?.();
    const st = lstatSync(socketPath, { bigint: true, throwIfNoEntry: false });
    if (bound === null || st === undefined || !sameFile(st, bound)) {
      // external: Node unlinks a Unix server's path when it closes, and that path now names
      // another listener's socket, so this one is left unreachable and unref'd instead
      server.unref();
      throw new Error(`${socketPath} is not the socket this server bound (another start replaced it); refusing to run`);
    }
    if (!st.isSocket() || st.uid !== BigInt(uid) || (st.mode & 0o777n) !== 0o600n) {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      throw new Error(`the phone socket came up with mode ${(st.mode & 0o777n).toString(8)}, not 600; closed it`);
    }
  } catch (error) { release(); throw error; }
}
