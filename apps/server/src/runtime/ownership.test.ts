import { type ChildProcess, spawn } from "node:child_process";
import { existsSync } from "node:fs";
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
import { removeDir, tmpDir } from "./test-fakes.ts";

let work: string;
let file: string;
const children: ChildProcess[] = [];

function sleeper(): ChildProcess {
  const c = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
  children.push(c);
  return c;
}

const alive = (pid: number) => readProc(pid) !== undefined;

async function waitFor(pred: () => boolean, ms = 3000) {
  const end = Date.now() + ms;
  while (!pred() && Date.now() < end) await new Promise((r) => setTimeout(r, 20));
  return pred();
}

beforeEach(() => {
  work = tmpDir("own");
  file = path.join(work, "owned-ollama.json");
});

afterEach(() => {
  for (const c of children.splice(0)) c.kill("SIGKILL");
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
    expect(me?.startTime).toMatch(/^\d+$/);
    expect(me?.command).toContain("node");
  });

  it("returns undefined for a PID that does not exist", () => {
    expect(readProc(2 ** 22 + 7)).toBeUndefined();
  });
});

describe("stopOwned", () => {
  it("stops a process whose PID, start time and command all match the record", async () => {
    const c = sleeper();
    await waitFor(() => alive(c.pid!));
    recordFor(c.pid!);
    expect(checkOwnership(file).kind).toBe("ours");
    const r = await stopOwned(file, 2000);
    expect(r).toEqual({ stopped: true, pid: c.pid });
    expect(await waitFor(() => !alive(c.pid!))).toBe(true);
    expect(existsSync(file)).toBe(false);
  });

  it("refuses a recorded PID now running a different command, and leaves it running", async () => {
    const c = sleeper();
    await waitFor(() => alive(c.pid!));
    recordFor(c.pid!, { command: "/home/someone/.local/share/gates-local/runtime/ollama/0.40.15/bin/ollama serve" });
    const r = await stopOwned(file, 500);
    expect(r.stopped).toBe(false);
    expect(r.stopped === false && r.reason).toBe("not-ours");
    await new Promise((res) => setTimeout(res, 200));
    expect(alive(c.pid!)).toBe(true);
    expect(c.exitCode).toBeNull();
    expect(c.signalCode).toBeNull();
    expect(readRecord(file)).toBeUndefined();
  });

  it("refuses a recorded PID with a different start time (PID reuse), and leaves it running", async () => {
    const c = sleeper();
    await waitFor(() => alive(c.pid!));
    const real = readProc(c.pid!)!.startTime;
    recordFor(c.pid!, { startTime: String(Number(real) - 1) });
    const r = await stopOwned(file, 500);
    expect(r.stopped === false && r.reason).toBe("not-ours");
    await new Promise((res) => setTimeout(res, 200));
    expect(alive(c.pid!)).toBe(true);
    expect(c.signalCode).toBeNull();
  });

  it("reports a recorded process that has exited as gone", async () => {
    const c = sleeper();
    await waitFor(() => alive(c.pid!));
    recordFor(c.pid!);
    c.kill("SIGKILL");
    await waitFor(() => !alive(c.pid!));
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
      const other = sleeper();
      await waitFor(() => alive(other.pid!));
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

/** A child process listening on host:port; resolves once it is listening. */
function listenerChild(host: string, port: number): Promise<ChildProcess> {
  const c = spawn(process.execPath, ["-e", `require("node:net").createServer().listen(${port}, ${JSON.stringify(host)}, () => console.log("up"))`], { stdio: ["ignore", "pipe", "ignore"] });
  children.push(c);
  return new Promise((resolve, reject) => {
    c.stdout!.once("data", () => resolve(c));
    c.once("exit", (code) => reject(new Error(`listener child exited ${code}`)));
  });
}

describe("listenerPid matches the probed address (R2-06)", () => {
  it("a recorded pid on 127.0.0.2:p beside a foreign pid on 127.0.0.1:p is not ours; 0.0.0.0, [::] and mapped addresses are", async () => {
    const fs = addrFs();
    // The probed endpoint is 127.0.0.1:11435; the recorded pid holds 127.0.0.2:11435 only.
    expect(readLinuxListenerPid(11435, [300], fs, "127.0.0.1")).toBeUndefined();
    expect(await listenerPid(11435, { platform: "linux", fs, pids: [300], host: "127.0.0.1" })).toBeUndefined();
    expect(readLinuxListenerPid(11435, undefined, fs, "127.0.0.1")).toBe(400);
    expect(readLinuxListenerPid(11435, [300], fs, "127.0.0.2")).toBe(300);
    // Wildcards: 0.0.0.0 for IPv4; [::] for IPv6, and for IPv4 while dual-stack.
    expect(readLinuxListenerPid(11438, [300], fs, "127.0.0.1")).toBe(300);
    expect(readLinuxListenerPid(11438, [300], fs, "::1")).toBeUndefined();
    expect(readLinuxListenerPid(11439, [300], fs, "::1")).toBe(300);
    expect(readLinuxListenerPid(11439, [300], fs, "127.0.0.1")).toBe(300);
    expect(readLinuxListenerPid(11439, [300], addrFs("1\n"), "127.0.0.1")).toBeUndefined();
    // [::ffff:127.0.0.1] serves 127.0.0.1; [::1] serves only ::1.
    expect(readLinuxListenerPid(11440, [300], fs, "127.0.0.1")).toBe(300);
    expect(readLinuxListenerPid(11441, [300], fs, "127.0.0.1")).toBeUndefined();
    expect(readLinuxListenerPid(11441, [300], fs, "::1")).toBe(300);
    // Not an address literal: nothing matches (never "ours").
    expect(readLinuxListenerPid(11438, [300], fs, "localhost")).toBeUndefined();
  });

  it("Linux, this machine: this process on 127.0.0.2:p and a child on 127.0.0.1:p; probing 127.0.0.1 is the child's", async () => {
    const server = createServer();
    await new Promise<void>((r) => server.listen(0, "127.0.0.2", r));
    try {
      const { port } = server.address() as AddressInfo;
      const child = await listenerChild("127.0.0.1", port);
      expect(await listenerPid(port, { platform: "linux", pids: [process.pid], host: "127.0.0.1" })).toBeUndefined();
      expect(await listenerPid(port, { platform: "linux", pids: [child.pid!], host: "127.0.0.1" })).toBe(child.pid);
      expect(await listenerPid(port, { platform: "linux", pids: [process.pid], host: "127.0.0.2" })).toBe(process.pid);
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
