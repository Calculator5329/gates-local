// The version this copy runs, read straight from the .git folder: the
// release tag when HEAD is one, else the short commit, with the commit's
// date. No git process and no network, so the server can show it at start
// and Settings can show it on open; only "Check for updates" runs git.
//
// It reads what a clone holds: HEAD, loose refs, packed-refs, loose objects
// and pack files (index v2, with delta chains). Anything it cannot read
// leaves the date out, or says the version is unreadable; never throws.
import { closeSync, existsSync, fstatSync, openSync, readFileSync, readSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { inflateSync } from "node:zlib";
import { newestRelease } from "./semver.ts";

export type VersionInfo =
  | { readonly kind: "release"; readonly tag: string; readonly commit: string; readonly date?: number }
  | { readonly kind: "commit"; readonly commit: string; readonly date?: number }
  | { readonly kind: "not-a-clone" }
  | { readonly kind: "unreadable"; readonly detail: string };

const SHORT = 7;
const MAX_DELTA_DEPTH = 64;
const MAX_TAG_DEPTH = 8;

interface Repo {
  readonly gitDir: string;
  readonly commonDir: string;
}

/** .git is a folder in a clone and a "gitdir:" file in a worktree. */
function openRepo(root: string): Repo | null {
  const dotGit = path.join(root, ".git");
  let gitDir: string;
  try {
    if (statSync(dotGit).isDirectory()) gitDir = dotGit;
    else {
      const line = readFileSync(dotGit, "utf8").trim();
      if (!line.startsWith("gitdir:")) return null;
      gitDir = path.resolve(root, line.slice("gitdir:".length).trim());
    }
  } catch {
    return null;
  }
  let commonDir = gitDir;
  try {
    commonDir = path.resolve(gitDir, readFileSync(path.join(gitDir, "commondir"), "utf8").trim());
  } catch {
    // A plain clone: no commondir.
  }
  return existsSync(path.join(gitDir, "HEAD")) ? { gitDir, commonDir } : null;
}

const isHash = (s: string) => /^([0-9a-f]{40}|[0-9a-f]{64})$/.test(s);

interface PackedRef {
  readonly hash: string;
  /** The commit an annotated tag points at, when packed-refs recorded it. */
  readonly peeled?: string;
}

function packedRefs(repo: Repo): Map<string, PackedRef> {
  const refs = new Map<string, PackedRef>();
  let text: string;
  try {
    text = readFileSync(path.join(repo.commonDir, "packed-refs"), "utf8");
  } catch {
    return refs;
  }
  let last: string | undefined;
  for (const line of text.split("\n")) {
    if (line.startsWith("^") && last !== undefined) {
      const prev = refs.get(last);
      if (prev !== undefined && isHash(line.slice(1).trim())) refs.set(last, { ...prev, peeled: line.slice(1).trim() });
      continue;
    }
    const [hash, name] = line.trim().split(" ");
    if (hash !== undefined && name !== undefined && isHash(hash)) {
      refs.set(name, { hash });
      last = name;
    } else last = undefined;
  }
  return refs;
}

function looseRef(repo: Repo, name: string): string | undefined {
  // Per-worktree refs (HEAD itself) live in the gitDir, shared refs in the commonDir.
  for (const dir of [repo.gitDir, repo.commonDir]) {
    try {
      return readFileSync(path.join(dir, ...name.split("/")), "utf8").trim();
    } catch {
      // Try the next folder.
    }
  }
  return undefined;
}

function resolveRef(repo: Repo, name: string, packed: Map<string, PackedRef>, depth = 0): string | undefined {
  if (depth > 5) return undefined;
  const value = looseRef(repo, name) ?? packed.get(name)?.hash;
  if (value === undefined) return undefined;
  if (value.startsWith("ref:")) return resolveRef(repo, value.slice(4).trim(), packed, depth + 1);
  return isHash(value) ? value : undefined;
}

// ---------------------------------------------------------------- objects

interface GitObject {
  readonly type: "commit" | "tree" | "blob" | "tag";
  readonly body: Buffer;
}

const PACK_TYPES = { 1: "commit", 2: "tree", 3: "blob", 4: "tag" } as const;

function readLoose(repo: Repo, hash: string): GitObject | undefined {
  let raw: Buffer;
  try {
    raw = inflateSync(readFileSync(path.join(repo.commonDir, "objects", hash.slice(0, 2), hash.slice(2))));
  } catch {
    return undefined;
  }
  const nul = raw.indexOf(0);
  const type = raw.subarray(0, nul).toString("latin1").split(" ")[0];
  if (type !== "commit" && type !== "tree" && type !== "blob" && type !== "tag") return undefined;
  return { type, body: raw.subarray(nul + 1) };
}

/** Finds hash in a pack index (version 2) and returns its offset in the pack, or undefined. */
export function indexOffset(idx: Buffer, hash: string): number | undefined {
  if (idx.length < 8 + 256 * 4 || idx.readUInt32BE(0) !== 0xff744f63 || idx.readUInt32BE(4) !== 2) return undefined;
  const want = Buffer.from(hash, "hex");
  const width = want.length;
  const total = idx.readUInt32BE(8 + 255 * 4);
  const first = want[0]!;
  let lo = first === 0 ? 0 : idx.readUInt32BE(8 + (first - 1) * 4);
  let hi = idx.readUInt32BE(8 + first * 4);
  const names = 8 + 256 * 4;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    const cmp = idx.compare(want, 0, width, names + mid * width, names + (mid + 1) * width) * -1;
    if (cmp === 0) {
      const offsets = names + total * width + total * 4;
      const small = idx.readUInt32BE(offsets + mid * 4);
      if ((small & 0x80000000) === 0) return small;
      const large = offsets + total * 4 + (small & 0x7fffffff) * 8;
      return Number(idx.readBigUInt64BE(large));
    }
    if (cmp < 0) hi = mid;
    else lo = mid + 1;
  }
  return undefined;
}

/** Applies a git delta to its base. */
export function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let at = 0;
  const varint = () => {
    let value = 0;
    let shift = 0;
    let byte: number;
    do {
      byte = delta[at++]!;
      value += (byte & 0x7f) * 2 ** shift;
      shift += 7;
    } while (byte & 0x80);
    return value;
  };
  const baseSize = varint();
  if (baseSize !== base.length) throw new Error("delta base size does not match");
  const out = Buffer.alloc(varint());
  let written = 0;
  while (at < delta.length) {
    const op = delta[at++]!;
    if (op & 0x80) {
      let offset = 0;
      let size = 0;
      for (let i = 0; i < 4; i++) if (op & (1 << i)) offset += delta[at++]! * 2 ** (8 * i);
      for (let i = 0; i < 3; i++) if (op & (1 << (4 + i))) size += delta[at++]! * 2 ** (8 * i);
      if (size === 0) size = 0x10000;
      if (offset + size > base.length) throw new Error("delta copies past its base");
      base.copy(out, written, offset, offset + size);
      written += size;
    } else if (op !== 0) {
      delta.copy(out, written, at, at + op);
      at += op;
      written += op;
    } else throw new Error("delta has a zero opcode");
  }
  if (written !== out.length) throw new Error("delta result has the wrong size");
  return out;
}

function readAt(fd: number, position: number, length: number): Buffer {
  const buf = Buffer.alloc(length);
  const n = readSync(fd, buf, 0, length, position);
  return buf.subarray(0, n);
}

function packEntry(repo: Repo, fd: number, packSize: number, offset: number, width: number, depth: number): GitObject {
  if (depth > MAX_DELTA_DEPTH) throw new Error("delta chain too deep");
  const head = readAt(fd, offset, 32);
  let at = 0;
  let byte = head[at++]!;
  const type = (byte >> 4) & 7;
  let size = byte & 0x0f;
  let shift = 4;
  while (byte & 0x80) {
    byte = head[at++]!;
    size += (byte & 0x7f) * 2 ** shift;
    shift += 7;
  }
  let base: GitObject | undefined;
  if (type === 6) {
    byte = head[at++]!;
    let back = byte & 0x7f;
    while (byte & 0x80) {
      byte = head[at++]!;
      back = (back + 1) * 128 + (byte & 0x7f);
    }
    base = packEntry(repo, fd, packSize, offset - back, width, depth + 1);
  } else if (type === 7) {
    const baseHash = readAt(fd, offset + at, width).toString("hex");
    at += width;
    base = readObject(repo, baseHash, depth + 1);
    if (base === undefined) throw new Error("delta base missing");
  }
  // The compressed data is at most a little larger than the data itself.
  const data = inflateSync(readAt(fd, offset + at, Math.min(packSize - offset - at, size + 1024 + Math.ceil(size / 100))));
  if (base !== undefined) return { type: base.type, body: applyDelta(base.body, data) };
  const name = PACK_TYPES[type as keyof typeof PACK_TYPES];
  if (name === undefined) throw new Error(`unknown pack object type ${type}`);
  return { type: name, body: data };
}

function readPacked(repo: Repo, hash: string, depth: number): GitObject | undefined {
  const dir = path.join(repo.commonDir, "objects", "pack");
  let files: string[];
  try {
    files = readdirSync(dir).filter((f) => f.endsWith(".idx"));
  } catch {
    return undefined;
  }
  for (const file of files) {
    let offset: number | undefined;
    try {
      offset = indexOffset(readFileSync(path.join(dir, file)), hash);
    } catch {
      continue;
    }
    if (offset === undefined) continue;
    const fd = openSync(path.join(dir, file.replace(/\.idx$/, ".pack")), "r");
    try {
      return packEntry(repo, fd, fstatSync(fd).size, offset, hash.length / 2, depth);
    } finally {
      closeSync(fd);
    }
  }
  return undefined;
}

function readObject(repo: Repo, hash: string, depth = 0): GitObject | undefined {
  return readLoose(repo, hash) ?? readPacked(repo, hash, depth);
}

/** One object of the clone at root, for the tests that check the pack reader against git. */
export function objectIn(root: string, hash: string): GitObject | undefined {
  const repo = openRepo(root);
  return repo === null ? undefined : readObject(repo, hash);
}

/** The commit an object names, following annotated tags. */
function peel(repo: Repo, hash: string): string | undefined {
  let at = hash;
  for (let i = 0; i < MAX_TAG_DEPTH; i++) {
    const obj = readObject(repo, at);
    if (obj === undefined) return undefined;
    if (obj.type === "commit") return at;
    if (obj.type !== "tag") return undefined;
    const target = /^object ([0-9a-f]+)$/m.exec(obj.body.toString("utf8"))?.[1];
    if (target === undefined) return undefined;
    at = target;
  }
  return undefined;
}

function releaseTagsAt(repo: Repo, commit: string, packed: Map<string, PackedRef>): string[] {
  const found = new Set<string>();
  for (const [name, ref] of packed) {
    if (!name.startsWith("refs/tags/v")) continue;
    // A loose ref of the same name wins over packed-refs.
    if (existsSync(path.join(repo.commonDir, "refs", "tags", name.slice("refs/tags/".length)))) continue;
    if ((ref.peeled ?? (ref.hash === commit ? commit : peel(repo, ref.hash))) === commit) found.add(name.slice("refs/tags/".length));
  }
  let loose: string[] = [];
  try {
    loose = readdirSync(path.join(repo.commonDir, "refs", "tags")).filter((t) => t.startsWith("v"));
  } catch {
    // No loose tags.
  }
  for (const tag of loose) {
    const value = looseRef(repo, `refs/tags/${tag}`);
    if (value !== undefined && isHash(value) && (value === commit || peel(repo, value) === commit)) found.add(tag);
  }
  return [...found];
}

function commitDate(repo: Repo, commit: string): number | undefined {
  try {
    const obj = readObject(repo, commit);
    if (obj?.type !== "commit") return undefined;
    const seconds = /^committer .* (\d+) [+-]\d{4}$/m.exec(obj.body.toString("utf8"))?.[1];
    return seconds === undefined ? undefined : Number(seconds) * 1000;
  } catch {
    return undefined;
  }
}

export function readVersion(root: string): VersionInfo {
  try {
    const repo = openRepo(root);
    if (repo === null) return { kind: "not-a-clone" };
    const packed = packedRefs(repo);
    const commit = resolveRef(repo, "HEAD", packed);
    if (commit === undefined) return { kind: "unreadable", detail: "HEAD does not name a commit" };
    const date = commitDate(repo, commit);
    const tag = newestRelease(releaseTagsAt(repo, commit, packed));
    const short = commit.slice(0, SHORT);
    const dated = date === undefined ? {} : { date };
    return tag !== undefined ? { kind: "release", tag, commit: short, ...dated } : { kind: "commit", commit: short, ...dated };
  } catch (e) {
    return { kind: "unreadable", detail: (e as Error).message };
  }
}
