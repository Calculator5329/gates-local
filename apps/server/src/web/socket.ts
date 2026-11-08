// The phone listener's Unix socket. Tailscale Serve (tailscaled, root) proxies
// to it with `tailscale serve --bg --https=8456 unix:<path>`; no other local
// user may open it, because this listener takes Serve's headers as identity.
// Two locks, either enough on its own:
//   - the parent directory is a real directory (lstat, so not a link) owned by
//     this uid with no group or other access; missing, it is made 0700;
//   - the socket is bound under umask 0177, so bind() creates it 0600. bind is
//     synchronous inside listen(), so the umask covers the creation itself and
//     there is no moment the file exists wider. The mode is checked after
//     listen and a wrong one closes the listener (no chmod to paper over it).
// A file already at the path is removed only when lstat shows a socket owned
// by this uid and a connect to it is refused (a dead server's leftover);
// anything else stops the start. Node unlinks the socket when it closes.
//
// Two starts at once (the app's single-instance lock normally prevents it)
// could both find the same dead socket. The path is lstat'ed again after the
// refused probe and left alone if it is no longer that file (dev, ino, uid,
// type), and after listen the path must still be the file this bind made.
// What remains is the moment between those lstats and the unlink or bind. A
// process can only act there as the same user, since the directory is 0700
// and ours. At worst one listener ends up with no path, so the phone cannot
// reach it until a restart; nobody gains access.
import { type Stats, lstatSync, mkdirSync, unlinkSync } from "node:fs";
import type { Server } from "node:http";
import { connect } from "node:net";
import path from "node:path";

/** Linux sun_path is 108 bytes including the terminating NUL. */
const MAX_SOCKET_PATH_BYTES = 107;

function code(e: unknown): string | undefined {
  return typeof e === "object" && e !== null ? (e as { code?: string }).code : undefined;
}

function ownUid(): number {
  if (typeof process.getuid !== "function") throw new Error("the phone socket needs a POSIX system (owner and mode checks)");
  return process.getuid();
}

/** The parent must be ours alone; a missing one is made 0700 (not recursively). */
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

/** Resolves true when something accepts a connection on the socket. */
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

/** Test seams, awaited at the two points a concurrent start can interleave; absent in the app. */
export interface SocketTestHooks {
  readonly afterRefusedProbe?: () => Promise<void>;
  readonly afterBind?: () => Promise<void>;
}

/** Clears a dead server's socket at the path; refuses anything else there. */
async function clearStale(socketPath: string, uid: number, hooks: SocketTestHooks): Promise<void> {
  let st;
  try {
    st = lstatSync(socketPath);
  } catch (e) {
    if (code(e) === "ENOENT") return;
    throw e;
  }
  if (!st.isSocket()) throw new Error(`${socketPath} exists and is not a socket; refusing to touch it`);
  if (st.uid !== uid) throw new Error(`${socketPath} is a socket owned by uid ${st.uid}, not this user; refusing to touch it`);
  if (await answers(socketPath)) throw new Error(`another server is already listening on ${socketPath}`);
  await hooks.afterRefusedProbe?.();
  // A second start may have cleared the same dead socket and bound its own
  // while the probe ran; that one is live, so leave it.
  let now;
  try {
    now = lstatSync(socketPath);
  } catch (e) {
    throw new Error(`the stale socket at ${socketPath} changed while it was being checked; refusing to touch it`, { cause: e });
  }
  if (!now.isSocket() || now.uid !== st.uid || now.dev !== st.dev || now.ino !== st.ino) {
    throw new Error(`the stale socket at ${socketPath} changed while it was being checked; refusing to touch it`);
  }
  unlinkSync(socketPath);
}

function sameFile(a: Stats, b: Stats): boolean {
  return a.dev === b.dev && a.ino === b.ino;
}

/** Binds server to socketPath, owner-only. Throws, with nothing bound, on any check that fails. */
export async function listenOwnerSocket(server: Server, socketPath: string, hooks: SocketTestHooks = {}): Promise<void> {
  if (!path.isAbsolute(socketPath)) throw new Error(`the phone socket path must be absolute, got "${socketPath}"`);
  if (Buffer.byteLength(socketPath) > MAX_SOCKET_PATH_BYTES) throw new Error(`the phone socket path is over ${MAX_SOCKET_PATH_BYTES} bytes`);
  const uid = ownUid();
  checkParent(path.dirname(socketPath), uid);
  await clearStale(socketPath, uid, hooks);
  let bound: Stats | null = null;
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    // Throws in a worker thread; that stops the start, which is the safe side.
    const old = process.umask(0o177);
    try {
      server.listen(socketPath, () => {
        server.off("error", reject);
        resolve();
      });
      // bind() ran inside listen(), so this is the file it made, unless a
      // bind error is about to arrive on "error".
      bound = lstatSync(socketPath, { throwIfNoEntry: false }) ?? null;
    } finally {
      process.umask(old);
    }
  });
  await hooks.afterBind?.();
  const st = lstatSync(socketPath, { throwIfNoEntry: false });
  if (bound === null || st === undefined || !sameFile(st, bound)) {
    // Not closed: closing a Unix server unlinks its path, which now names
    // another listener's socket (or nothing). This one has no path left, so
    // nothing can reach it; unref'd, it ends with the process.
    server.unref();
    throw new Error(`${socketPath} is not the socket this server bound (another start replaced it); refusing to run`);
  }
  if (!st.isSocket() || st.uid !== uid || (st.mode & 0o777) !== 0o600) {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    throw new Error(`the phone socket came up with mode ${(st.mode & 0o777).toString(8)}, not 600; closed it`);
  }
}
