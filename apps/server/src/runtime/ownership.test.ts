import { type ChildProcess, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { once } from "node:events";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  checkOwnership,
  listenInodes,
  listenerPid,
  parseWindowsListener,
  readLinuxListenerPid,
  readProc,
  readRecord,
  stopOwned,
  windowsListenerQuery,
  writeRecord,
  type ListenerFs,
  type SyncRunner,
} from "./ownership.ts";
import { removeDir, spawnSleeper, tmpDir } from "./test-fakes.ts";

let work: string;
let file: string;
const children: ChildProcess[] = [];
const startup = new WeakMap<ChildProcess, Promise<void>>();

async function sleeper(): Promise<ChildProcess> {
  const { child: c, ready } = spawnSleeper();
  startup.set(c, ready);
  children.push(c);
  await ready;
  return c;
}

const alive = (pid: number) => readProc(pid) !== undefined;

beforeEach(() => {
  work = tmpDir("own");
  file = path.join(work, "owned-ollama.json");
});

afterEach(async () => {
  for (const c of children.splice(0)) {
    if (c.exitCode !== null || c.signalCode !== null) continue;
    const exited = once(c, "exit");
    c.kill("SIGKILL");
    await exited;
  }
  removeDir(work);
});

function recordFor(pid: number, over: { startTime?: string; command?: string } = {}) {
  const p = readProc(pid);
  if (!p) throw new Error(`no /proc entry for ${pid}`);
  writeRecord(file, {
    pid,
    startTime: over.startTime ?? p.startTime,
    command: over.command ?? p.command,
    baseUrl: "http://127.0.0.1:1",
    binary: "/fake/ollama",
    startedAt: Date.now(),
  });
}

describe("readProc", () => {
  it("reads this process's start time and command line", () => {
    const me = readProc(process.pid);
    // Linux: clock ticks from /proc/<pid>/stat. Windows: CIM's CreationDate, an opaque string with the time in it.
    expect(me?.startTime).toMatch(process.platform === "win32" ? /\d{6,}/ : /^\d+$/);
    expect(me?.command).toContain("node");
  });

  it("returns undefined for a PID that does not exist", () => {
    expect(readProc(2 ** 22 + 7)).toBeUndefined();
  });
});

describe("stopOwned", () => {
  it("keeps the recorded identity once the child's startup finishes", async () => {
    const c = await sleeper();
    recordFor(c.pid!);
    await startup.get(c);
    expect(checkOwnership(file).kind).toBe("ours");
  });

  // Windows never stops a process by PID number (R-12): runtime.ts stops its own child through the handle.
  it.runIf(process.platform === "win32")("on Windows adopts a matching live record and leaves the process running", async () => {
    const c = await sleeper();
    recordFor(c.pid!);
    expect(checkOwnership(file).kind, JSON.stringify({ record: readRecord(file), now: readProc(c.pid!) })).toBe("ours");
    expect(await stopOwned(file, 500)).toEqual({ stopped: false, reason: "adopted" });
    expect(alive(c.pid!)).toBe(true);
    expect(c.exitCode).toBeNull();
  });

  it.skipIf(process.platform === "win32")("stops a process whose PID, start time and command all match the record", async () => {
    const c = await sleeper();
    recordFor(c.pid!);
    expect(checkOwnership(file).kind, JSON.stringify({ record: readRecord(file), now: readProc(c.pid!) })).toBe("ours");
    const exited = once(c, "exit");
    const r = await stopOwned(file, 2000);
    expect(r).toEqual({ stopped: true, pid: c.pid });
    await exited;
    expect(alive(c.pid!)).toBe(false);
    expect(existsSync(file)).toBe(false);
  });

  it("refuses a recorded PID now running a different command, and leaves it running", async () => {
    const c = await sleeper();
    recordFor(c.pid!, { command: "/different/ollama serve" });
    const r = await stopOwned(file, 500);
    expect(r.stopped).toBe(false);
    expect(r.stopped === false && r.reason).toBe("not-ours");
    expect(alive(c.pid!)).toBe(true);
    expect(c.exitCode).toBeNull();
    expect(c.signalCode).toBeNull();
    expect(readRecord(file)).toBeUndefined();
  });

  it("refuses a recorded PID with a different start time (PID reuse), and leaves it running", async () => {
    const c = await sleeper();
    const real = readProc(c.pid!)!.startTime;
    recordFor(c.pid!, { startTime: String(Number(real) - 1) });
    const r = await stopOwned(file, 500);
    expect(r.stopped === false && r.reason).toBe("not-ours");
    expect(alive(c.pid!)).toBe(true);
    expect(c.signalCode).toBeNull();
  });

  it("reports a recorded process that has exited as gone", async () => {
    const c = await sleeper();
    recordFor(c.pid!);
    const exited = once(c, "exit");
    c.kill("SIGKILL");
    await exited;
    expect(await stopOwned(file, 500)).toEqual({ stopped: false, reason: "gone" });
  });

  it("does nothing without a record", async () => {
    expect(await stopOwned(file)).toEqual({ stopped: false, reason: "no-record" });
  });
});

// /proc/net/tcp: 127.0.0.1:11435 (0x2CAB) LISTEN with inode 5551; the same port
// ESTABLISHED (state 01, a client) with inode 5552; another port listening.
const TCP = `  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode
   0: 0100007F:2CAB 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 5551 1 0000000000000000 100 0 0 10 0
   1: 0100007F:2CAB 0100007F:D431 01 00000000:00000000 00:00000000 00000000  1000        0 5552 1 0000000000000000 20 4 30 10 -1
   2: 0100007F:1FF2 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 7777 1 0000000000000000 100 0 0 10 0
`;
// /proc/net/tcp6: [::1]:11436 (0x2CAC) LISTEN with inode 6661.
const TCP6 = `  sl  local_address                         remote_address                        st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode
   0: 00000000000000000000000001000000:2CAC 00000000000000000000000000000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 6661 1 0000000000000000 100 0 0 10 0
`;

function fixtureFs(links: Record<number, Record<string, string>>): ListenerFs {
  return {
    readFile: (f) => {
      if (f === "/proc/net/tcp") return TCP;
      if (f === "/proc/net/tcp6") return TCP6;
      throw new Error(`ENOENT ${f}`);
    },
    readdir: (d) => {
      if (d === "/proc") return [...Object.keys(links), "self", "net"];
      const pid = Number(/^\/proc\/(\d+)\/fd$/.exec(d)?.[1]);
      const fds = links[pid];
      if (!fds) throw new Error(`EACCES ${d}`);
      return Object.keys(fds);
    },
    readlink: (f) => {
      const m = /^\/proc\/(\d+)\/fd\/(\d+)$/.exec(f);
      const link = m ? links[Number(m[1])]?.[m[2]!] : undefined;
      if (link === undefined) throw new Error(`ENOENT ${f}`);
      return link;
    },
  };
}

/** No listener: Get-NetTCPConnection -ErrorAction Stop exits non-zero. */
const noListener: SyncRunner = () => {
  throw new Error("No matching MSFT_NetTCPConnection objects found");
};

describe("listenerPid (S-04)", () => {
  it("Linux: reads LISTEN sockets on the port from /proc/net/tcp and tcp6, and nothing else", () => {
    expect(listenInodes(TCP, 11435)).toEqual(["5551"]);
    expect(listenInodes(TCP, 8178)).toEqual(["7777"]);
    expect(listenInodes(TCP, 11436)).toEqual([]);
    expect(listenInodes(TCP6, 11436)).toEqual(["6661"]);
    expect(listenInodes("garbage\nnot a table\n", 11435)).toEqual([]);
  });

  it("Linux: names the process whose fd links to the listening inode", async () => {
    const fs = fixtureFs({
      100: { "0": "/dev/null", "3": "socket:[5552]" }, // a client of the port, not its listener
      200: { "0": "/dev/null", "7": "socket:[5551]", "8": "socket:[6661]" },
    });
    expect(readLinuxListenerPid(11435, undefined, fs)).toBe(200);
    // [::1]:11436 serves an IPv6 probe of ::1, not the default 127.0.0.1 (R2-06).
    expect(readLinuxListenerPid(11436, undefined, fs, "::1")).toBe(200);
    expect(readLinuxListenerPid(11436, undefined, fs)).toBeUndefined();
    // Only the recorded pid is searched: a listener held by someone else reads as undefined.
    expect(readLinuxListenerPid(11435, [100], fs)).toBeUndefined();
    expect(readLinuxListenerPid(11435, [300], fs)).toBeUndefined();
    expect(readLinuxListenerPid(11437, undefined, fs)).toBeUndefined();
    expect(await listenerPid(11435, { platform: "linux", fs, pids: [200] })).toBe(200);
  });

  it("Linux, this machine: a socket this process listens on belongs to this process, not to another", async () => {
    const server = createServer();
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    try {
      const { port } = server.address() as AddressInfo;
      expect(await listenerPid(port, { platform: "linux", pids: [process.pid] })).toBe(process.pid);
      const other = await sleeper();
      expect(await listenerPid(port, { platform: "linux", pids: [other.pid!] })).toBeUndefined();
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  });

  it("Windows: parses Get-NetTCPConnection's OwningProcess; empty, malformed or split answers are undefined", async () => {
    expect(parseWindowsListener('{"OwningProcess":4242}')).toBe(4242);
    // IPv4 and IPv6 listeners of one process.
    expect(parseWindowsListener('[{"OwningProcess":4242},{"OwningProcess":4242}]')).toBe(4242);
    expect(parseWindowsListener('[{"OwningProcess":4242},{"OwningProcess":999}]')).toBeUndefined();
    expect(parseWindowsListener("")).toBeUndefined();
    expect(parseWindowsListener("not json")).toBeUndefined();
    expect(parseWindowsListener('{"OwningProcess":"4242"}')).toBeUndefined();
    const calls: string[][] = [];
    const run: SyncRunner = (f, args) => {
      calls.push([f, ...args]);
      return '{"OwningProcess":4242}';
    };
    expect(await listenerPid(11435, { platform: "win32", run })).toBe(4242);
    expect(calls[0]).toEqual(["powershell.exe", "-NoProfile", "-NonInteractive", "-Command", windowsListenerQuery(11435)]);
    expect(await listenerPid(11435, { platform: "win32", run: noListener })).toBeUndefined();
  });

  it("any other platform is undefined", async () => {
    expect(await listenerPid(11435, { platform: "darwin" })).toBeUndefined();
  });
});

// R2-06. Port 11435 (0x2CAB): the recorded pid 300 listens on 127.0.0.2,
// a foreign pid 400 on 127.0.0.1. 11438 (0x2CAE): 300 on 0.0.0.0.
// tcp6: 11439 (0x2CAF) 300 on [::]; 11440 (0x2CB0) 300 on [::ffff:127.0.0.1];
// 11441 (0x2CB1) 300 on [::1].
const ADDR_TCP = `  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode
   0: 0200007F:2CAB 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 8001 1 0000000000000000 100 0 0 10 0
   1: 0100007F:2CAB 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 8002 1 0000000000000000 100 0 0 10 0
   2: 00000000:2CAE 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 8003 1 0000000000000000 100 0 0 10 0
`;
const ADDR_TCP6 = `  sl  local_address                         remote_address                        st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode
   0: 00000000000000000000000000000000:2CAF 00000000000000000000000000000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 8004 1 0000000000000000 100 0 0 10 0
   1: 0000000000000000FFFF00000100007F:2CB0 00000000000000000000000000000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 8005 1 0000000000000000 100 0 0 10 0
   2: 00000000000000000000000001000000:2CB1 00000000000000000000000000000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 8006 1 0000000000000000 100 0 0 10 0
`;

function addrFs(bindv6only?: string): ListenerFs {
  const links: Record<number, Record<string, string>> = {
    300: { "3": "socket:[8001]", "4": "socket:[8003]", "5": "socket:[8004]", "6": "socket:[8005]", "7": "socket:[8006]" },
    400: { "3": "socket:[8002]" },
  };
  return {
    readFile: (f) => {
      if (f === "/proc/net/tcp") return ADDR_TCP;
      if (f === "/proc/net/tcp6") return ADDR_TCP6;
      if (f === "/proc/sys/net/ipv6/bindv6only" && bindv6only !== undefined) return bindv6only;
      throw new Error(`ENOENT ${f}`);
    },
    readdir: (d) => {
      if (d === "/proc") return Object.keys(links);
      const fds = links[Number(/^\/proc\/(\d+)\/fd$/.exec(d)?.[1])];
      if (!fds) throw new Error(`EACCES ${d}`);
      return Object.keys(fds);
    },
    readlink: (f) => {
      const m = /^\/proc\/(\d+)\/fd\/(\d+)$/.exec(f);
      const link = m ? links[Number(m[1])]?.[m[2]!] : undefined;
      if (link === undefined) throw new Error(`ENOENT ${f}`);
      return link;
    },
  };
}

/** Hand the child an already-bound IPv4 socket; the parent still binds its second address. */
function listenerChild(server: ReturnType<typeof createServer>): Promise<ChildProcess> {
  const c = spawn(process.execPath, ["-e", 'process.on("message", (_message, server) => { server.on("connection", socket => socket.end()); process.send("ready"); });'], { stdio: ["ignore", "pipe", "pipe", "ipc"] });
  children.push(c);
  let stderr = "";
  c.stderr!.setEncoding("utf8").on("data", (text: string) => { stderr += text; });
  return new Promise((resolve, reject) => {
    const failed = (code: number | null, signal: NodeJS.Signals | null) => reject(new Error(`listener child exited ${signal ?? code}\n${stderr}`));
    c.once("error", reject);
    c.once("exit", failed);
    c.once("message", () => {
      c.off("error", reject);
      c.off("exit", failed);
      resolve(c);
    });
    c.send("listen", server, error => { if (error) reject(error); });
  });
}

async function listenerPair(host: string) {
  const handed = createServer();
  const server = createServer();
  try {
    await new Promise<void>((resolve, reject) => {
      handed.once("error", reject);
      handed.listen(0, "127.0.0.1", resolve);
    });
    const address = handed.address();
    if (!address || typeof address === "string") throw new Error("Missing listener address");
    const { port } = address;
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen({ port, host, ipv6Only: true }, resolve);
    });
    const child = await listenerChild(handed);
    await new Promise<void>(resolve => handed.close(() => resolve()));
    return { server, port, child };
  } catch (error) {
    await Promise.all([handed, server].map(socket => new Promise<void>(resolve => socket.close(() => resolve()))));
    throw error;
  }
}

describe("listenerPid matches the probed address (R2-06)", () => {
  it("a recorded pid on 127.0.0.2:p beside a foreign pid on 127.0.0.1:p is not ours; 0.0.0.0 and mapped addresses are, [::] only for IPv6", async () => {
    const fs = addrFs();
    // The probed endpoint is 127.0.0.1:11435; the recorded pid holds 127.0.0.2:11435 only.
    expect(readLinuxListenerPid(11435, [300], fs, "127.0.0.1")).toBeUndefined();
    expect(await listenerPid(11435, { platform: "linux", fs, pids: [300], host: "127.0.0.1" })).toBeUndefined();
    expect(readLinuxListenerPid(11435, undefined, fs, "127.0.0.1")).toBe(400);
    expect(readLinuxListenerPid(11435, [300], fs, "127.0.0.2")).toBe(300);
    // Wildcards: 0.0.0.0 for IPv4; [::] for IPv6 only, whatever bindv6only says (no per-socket evidence).
    expect(readLinuxListenerPid(11438, [300], fs, "127.0.0.1")).toBe(300);
    expect(readLinuxListenerPid(11438, [300], fs, "::1")).toBeUndefined();
    expect(readLinuxListenerPid(11439, [300], fs, "::1")).toBe(300);
    expect(readLinuxListenerPid(11439, [300], addrFs("0\n"), "127.0.0.1")).toBeUndefined();
    expect(readLinuxListenerPid(11439, [300], addrFs("1\n"), "127.0.0.1")).toBeUndefined();
    // [::ffff:127.0.0.1] serves 127.0.0.1; [::1] serves only ::1.
    expect(readLinuxListenerPid(11440, [300], fs, "127.0.0.1")).toBe(300);
    expect(readLinuxListenerPid(11441, [300], fs, "127.0.0.1")).toBeUndefined();
    expect(readLinuxListenerPid(11441, [300], fs, "::1")).toBe(300);
    // Not an address literal: nothing matches (never "ours").
    expect(readLinuxListenerPid(11438, [300], fs, "localhost")).toBeUndefined();
  });

  it("Linux, this machine: this process on 127.0.0.2:p and a child on 127.0.0.1:p; probing 127.0.0.1 is the child's", async () => {
    const { server, port, child } = await listenerPair("127.0.0.2");
    try {
      expect(await listenerPid(port, { platform: "linux", pids: [process.pid], host: "127.0.0.1" })).toBeUndefined();
      expect(await listenerPid(port, { platform: "linux", pids: [child.pid!], host: "127.0.0.1" })).toBe(child.pid);
      expect(await listenerPid(port, { platform: "linux", pids: [process.pid], host: "127.0.0.2" })).toBe(process.pid);
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  });

  it("Linux, this machine: this process on [::]:p with ipv6Only and a child on 127.0.0.1:p; probing 127.0.0.1 is never this process's", async () => {
    // The kernel default (bindv6only 0) says nothing about one socket: this one is IPv6-only.
    const { server, port, child } = await listenerPair("::");
    try {
      expect(await listenerPid(port, { platform: "linux", pids: [process.pid], host: "127.0.0.1" })).toBeUndefined();
      expect(await listenerPid(port, { platform: "linux", pids: [child.pid!], host: "127.0.0.1" })).toBe(child.pid);
      expect(await listenerPid(port, { platform: "linux", pids: [process.pid], host: "::1" })).toBe(process.pid);
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  });

  it("Linux, this machine: a listener on 0.0.0.0:p is still ours when 127.0.0.1:p is probed", async () => {
    const server = createServer();
    await new Promise<void>((r) => server.listen(0, "0.0.0.0", r));
    try {
      const { port } = server.address() as AddressInfo;
      expect(await listenerPid(port, { platform: "linux", pids: [process.pid], host: "127.0.0.1" })).toBe(process.pid);
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  });
});
