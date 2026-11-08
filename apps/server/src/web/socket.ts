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
import { lstatSync, mkdirSync, unlinkSync } from "node:fs";
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

/** Clears a dead server's socket at the path; refuses anything else there. */
async function clearStale(socketPath: string, uid: number): Promise<void> {
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
  unlinkSync(socketPath);
}

/** Binds server to socketPath, owner-only. Throws, with nothing bound, on any check that fails. */
export async function listenOwnerSocket(server: Server, socketPath: string): Promise<void> {
  if (!path.isAbsolute(socketPath)) throw new Error(`the phone socket path must be absolute, got "${socketPath}"`);
  if (Buffer.byteLength(socketPath) > MAX_SOCKET_PATH_BYTES) throw new Error(`the phone socket path is over ${MAX_SOCKET_PATH_BYTES} bytes`);
  const uid = ownUid();
  checkParent(path.dirname(socketPath), uid);
  await clearStale(socketPath, uid);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    // Throws in a worker thread; that stops the start, which is the safe side.
    const old = process.umask(0o177);
    try {
      server.listen(socketPath, () => {
        server.off("error", reject);
        resolve();
      });
    } finally {
      process.umask(old);
    }
  });
  const st = lstatSync(socketPath);
  if (!st.isSocket() || st.uid !== uid || (st.mode & 0o777) !== 0o600) {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    throw new Error(`the phone socket came up with mode ${(st.mode & 0o777).toString(8)}, not 600; closed it`);
  }
}
