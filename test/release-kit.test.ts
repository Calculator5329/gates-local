import { spawnSync, execFileSync } from "node:child_process";
import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, expect, test } from "vitest";

const cli = path.join(import.meta.dirname, "../scripts/release-kit.ts");
const folders: string[] = [];
const scratch = () => { const parent = path.join(homedir(), ".cache"); const dir = mkdtempSync(path.join(parent, "release-kit-test-")); folders.push(dir); return dir; };
afterEach(() => { for (const dir of folders.splice(0)) rmSync(dir, { recursive: true, force: true }); });
function checkout(dir: string) {
  mkdirSync(dir, { recursive: true });
  execFileSync("git", ["init", "-q", dir]);
  writeFileSync(path.join(dir, ".gitignore"), "dist/\n");
  return commit(dir);
}
function commit(dir: string) {
  execFileSync("git", ["-C", dir, "add", "."]);
  execFileSync("git", ["-C", dir, "-c", "user.name=Release test", "-c", "user.email=fixture", "commit", "-qm", "fixture"]);
  return execFileSync("git", ["-C", dir, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
}
const fakePackager = 'const fs = require("node:fs"); const v = process.env.GATES_LOCAL_BUILD_VERSION; const win = process.argv[2] === "package:win"; if (!process.env.FAKE_SKIP) { fs.mkdirSync("dist/installer", {recursive:true}); fs.writeFileSync("dist/installer/" + (win ? `Gates-Local-${v}-Setup-x64.exe` : `Gates-Local-${v}-x86_64.AppImage`), "installer"); } process.exitCode = Number(process.env.FAKE_EXIT || "0");';
function packager(dir: string) {
  const file = path.join(dir, "pnpm.cjs"); writeFileSync(file, fakePackager); return file;
}
function signingFixture(single = false) {
  const f = fixture();
  const args = single ? ["--allow-single-platform", f.linux] : [f.linux, f.windows];
  expect(run(f.dir, ["assemble", "--out", f.release, ...args]).status).toBe(0);
  const key = path.join(f.dir, "private.pem");
  writeFileSync(key, generateKeyPairSync("ed25519").privateKey.export({ type: "pkcs8", format: "pem" }), { mode: 0o600 });
  return { ...f, key };
}

test.each(["missing", "stale"])("artifact refuses %s installer after a zero-exit packager", (scenario) => {
  const dir = scratch(); const repo = path.join(dir, "repo"); checkout(repo);
  const env = { npm_execpath: packager(dir), FAKE_SKIP: "1" };
  const file = process.platform === "win32" ? windowsFile : linuxFile;
  const output = path.join(repo, "dist", "installer", file);
  const args = ["artifact", "--version", "1.2.3"];
  if (scenario === "stale") { mkdirSync(path.dirname(output), { recursive: true }); writeFileSync(output, "stale"); }
  expect(run(repo, args, env)).toMatchObject({ status: 1, output: expect.stringContaining(scenario === "stale" ? "archive it and its record first" : "did not produce") });
  expect(existsSync(output + ".record.json")).toBe(false);
});
test.skipIf(process.platform === "win32")("artifact starts a native executable directly and a cjs through Node", () => {
  const dir = scratch(); const repo = path.join(dir, "repo"); checkout(repo);
  // A real native Node binary stands in for standalone pnpm. It executes this
  // fake package script when invoked directly; parsing the binary as JS fails.
  writeFileSync(path.join(repo, "package:linux"), fakePackager); commit(repo);
  expect(run(repo, ["artifact", "--version", "1.2.3"], { npm_execpath: process.execPath })).toMatchObject({ status: 0, output: expect.stringContaining("record:") });
  const second = path.join(dir, "second"); checkout(second);
  expect(run(second, ["artifact", "--version", "1.2.3"], { npm_execpath: packager(dir) })).toMatchObject({ status: 0, output: expect.stringContaining("record:") });
});
test.each([
  ["gains an untracked file", ' fs.writeFileSync("changed-during-packaging.txt", "x");'],
  ["gains a commit", ' require("node:child_process").execFileSync("git", ["-c", "user.name=Release test", "-c", "user.email=fixture", "commit", "--allow-empty", "-qm", "moved"]);'],
])("artifact writes no record when the checkout %s during packaging", (_name, change) => {
  const dir = scratch(); const repo = path.join(dir, "repo"); checkout(repo);
  const file = path.join(dir, "pnpm.cjs");
  writeFileSync(file, fakePackager + change);
  const installer = path.join(repo, "dist", "installer", process.platform === "win32" ? windowsFile : linuxFile);
  expect(run(repo, ["artifact", "--version", "1.2.3"], { npm_execpath: file })).toMatchObject({ status: 1, output: expect.stringContaining("changed during packaging") });
  expect(existsSync(installer)).toBe(true);
  expect(existsSync(installer + ".record.json")).toBe(false);
});
test.each(["cmd", "bat"])("artifact refuses a pnpm %s wrapper without a shell", (extension) => {
  const dir = scratch(); const repo = path.join(dir, "repo"); checkout(repo);
  const wrapper = path.join(dir, `pnpm.${extension}`); writeFileSync(wrapper, "exit 0");
  expect(run(repo, ["artifact", "--version", "1.2.3"], { npm_execpath: wrapper })).toMatchObject({ status: 1, output: expect.stringContaining("JavaScript entry point or native executable") });
});
test("exported artifact requires a given commit, never invokes git, and records its provenance", () => {
  const dir = scratch(); const exported = path.join(dir, "exported"); mkdirSync(exported);
  const env = { npm_execpath: packager(dir), PATH: "" };
  const args = ["artifact", "--version", "1.2.3"];
  expect(run(exported, args, env)).toMatchObject({ status: 1, output: expect.stringContaining("--commit") });
  expect(run(exported, [...args, "--commit", "bad"], env)).toMatchObject({ status: 1, output: expect.stringContaining("40 lowercase hex") });
  const result = run(exported, [...args, "--commit", "a".repeat(40)], env);
  expect(result).toMatchObject({ status: 0, output: expect.stringContaining("commit was given, not read") });
  const file = process.platform === "win32" ? windowsFile : linuxFile;
  expect(JSON.parse(readFileSync(path.join(exported, "dist", "installer", file + ".record.json"), "utf8"))).toMatchObject({ commit: "a".repeat(40), commitFrom: "given" });
});
test("checkout artifact refuses a given commit different from HEAD", () => {
  const dir = scratch(); const repo = path.join(dir, "repo"); checkout(repo);
  expect(run(repo, ["artifact", "--version", "1.2.3", "--commit", "b".repeat(40)], { npm_execpath: packager(dir) })).toMatchObject({ status: 1, output: expect.stringContaining("does not match HEAD") });
});
test("sign rehashes changed files before signing and does not print the key in any encoding", () => {
  const f = signingFixture();
  const key = createPrivateKey(readFileSync(f.key));
  const der = key.export({ type: "pkcs8", format: "der" });
  const seed = der.subarray(der.length - 32);
  const file = path.join(f.release, linuxFile); const bytes = readFileSync(file); bytes[0] = bytes[0]! ^ 1; writeFileSync(file, bytes);
  const result = run(f.dir, ["sign", "--key", f.key, "--allow-untrusted-key", f.release]);
  expect(result).toMatchObject({ status: 1, output: expect.stringContaining("sha512 mismatch") });
  expect(existsSync(path.join(f.release, "release.json.sig"))).toBe(false);
  const pemBody = readFileSync(f.key, "utf8").split("\n").slice(1, -2).join("");
  for (const secret of [pemBody, seed.toString("base64"), seed.toString("base64url"), seed.toString("hex")]) expect(result.output).not.toContain(secret);
});
test("sign requires explicit permission for one-platform and untrusted proof signatures", () => {
  const f = signingFixture(true);
  expect(run(f.dir, ["sign", "--key", f.key, "--allow-untrusted-key", f.release])).toMatchObject({ status: 1, output: expect.stringContaining("--allow-single-platform") });
  expect(run(f.dir, ["sign", "--key", f.key, "--allow-single-platform", "--allow-untrusted-key", f.release])).toMatchObject({ status: 0, output: expect.stringContaining("installed copies will not accept this signature") });
});
test.each(["no checkout", "wrong commit", "untrusted key", "trusted key"] as const)("sign checks its release checkout: %s", (scenario) => {
  const f = fixture();
  const key = path.join(f.dir, "private.pem");
  const pair = generateKeyPairSync("ed25519");
  writeFileSync(key, pair.privateKey.export({ type: "pkcs8", format: "pem" }), { mode: 0o600 });
  const repo = path.join(f.dir, "repo"); const head = checkout(repo);
  const trustFile = path.join(repo, "apps/server/src/update/release-manifest.ts"); mkdirSync(path.dirname(trustFile), { recursive: true });
  const publicKey = pair.publicKey.export({ type: "spki", format: "der" }).toString("base64");
  // The wrong-commit case trusts the key, so only the commit check can refuse it.
  writeFileSync(trustFile, `export const TRUSTED_RELEASE_KEYS = ${JSON.stringify(scenario === "trusted key" || scenario === "wrong commit" ? [publicKey] : [])};\n`);
  const tip = commit(repo);
  const releaseCommit = scenario === "wrong commit" ? head : tip;
  record(f.dir, "linux", releaseCommit); record(f.dir, "win32", releaseCommit);
  expect(run(f.dir, ["assemble", "--out", f.release, f.linux, f.windows]).status).toBe(0);
  const cwd = scenario === "no checkout" ? f.dir : repo;
  const result = run(cwd, ["sign", "--key", key, f.release]);
  const message = { "no checkout": "checkout", "wrong commit": "does not match release.json commit", "untrusted key": "TRUSTED_RELEASE_KEYS", "trusted key": "signature: written" }[scenario];
  expect(result).toMatchObject({ status: scenario === "trusted key" ? 0 : 1, output: expect.stringContaining(message) });
  if (scenario !== "trusted key") expect(existsSync(path.join(f.release, "release.json.sig"))).toBe(false);
});
test("assemble publishes only after every copy succeeds and retains partial work on failure", () => {
  const f = fixture();
  const injection = path.join(f.dir, "fail-copy.mjs");
  writeFileSync(injection, 'import fs from "node:fs"; import { syncBuiltinESMExports } from "node:module"; const original = fs.copyFileSync; let copies = 0; fs.copyFileSync = (...args) => { if (++copies === 2) throw new Error("second copy failed"); return original(...args); }; syncBuiltinESMExports();');
  const result = run(f.dir, ["assemble", "--out", f.release, f.linux, f.windows], { NODE_OPTIONS: `--import=${pathToFileURL(injection).href}` });
  expect(result.status).toBe(1);
  expect(result.output).toContain("second copy failed");
  expect(existsSync(f.release)).toBe(false);
  expect(result.output).toContain("Partial release retained at:");
  const partial = readdirSync(f.dir).find((name) => name.startsWith(".release.partial-"));
  expect(partial).toBeDefined();
  if (partial) expect(existsSync(path.join(f.dir, partial, linuxFile))).toBe(true);
});
test("verify refuses an explicitly empty public-key argument", () => {
  const f = fixture();
  expect(run(f.dir, ["verify", f.release, "--public-key", ""])).toMatchObject({ status: 1, output: expect.stringContaining("--public-key must not be empty") });
});
test("assemble reports the provenance of every record", () => {
  const f = fixture();
  const result = run(f.dir, ["assemble", "--out", f.release, f.linux, f.windows]);
  expect(result.status).toBe(0);
  expect(result.output).toContain("linux.json commit source: git");
  expect(result.output).toContain("win32.json commit source: given");
});
test("verify reports the platform held by a one-platform list", () => {
  const f = signingFixture(true);
  expect(run(f.dir, ["sign", "--key", f.key, "--allow-single-platform", "--allow-untrusted-key", f.release]).status).toBe(0);
  const publicKey = createPublicKey(createPrivateKey(readFileSync(f.key))).export({ type: "spki", format: "der" }).toString("base64");
  expect(run(f.dir, ["verify", f.release, "--public-key", publicKey])).toMatchObject({ status: 0, output: expect.stringContaining("platforms: linux") });
});
function run(cwd: string, args: string[], env: NodeJS.ProcessEnv = {}) {
  const result = spawnSync(process.execPath, [cli, ...args], { cwd, encoding: "utf8", env: { ...process.env, ...env } });
  if (result.error) throw result.error;
  return { status: result.status, output: result.stdout + result.stderr };
}
const linuxFile = "Gates-Local-1.2.3-x86_64.AppImage";
const windowsFile = "Gates-Local-1.2.3-Setup-x64.exe";
function record(dir: string, platform = "linux", sourceCommit = "a".repeat(40)) {
  const file = platform === "linux" ? linuxFile : windowsFile;
  const bytes = Buffer.from("fake installer");
  writeFileSync(path.join(dir, file), bytes);
  const filename = path.join(dir, `${platform}.json`);
  writeFileSync(filename, JSON.stringify({ platform, arch: "x64", kind: platform === "linux" ? "appimage" : "nsis", file, size: bytes.length, sha512: createHash("sha512").update(bytes).digest("hex"), version: "1.2.3", commit: sourceCommit, commitFrom: platform === "linux" ? "git" : "given" }));
  return filename;
}
function fixture() {
  const dir = scratch();
  const linux = record(dir);
  const windows = record(dir, "win32");
  const release = path.join(dir, "release");
  return { dir, linux, windows, release };
}
function signed() {
  const f = fixture();
  const assembly = run(f.dir, ["assemble", "--out", f.release, f.linux, f.windows]);
  expect(assembly.status).toBe(0);
  const key = path.join(f.dir, "private.pem");
  const generated = run(f.dir, ["keygen", "--out", key]);
  expect(generated.status).toBe(0);
  const publicKey = generated.output.trim();
  const signing = run(f.dir, ["sign", "--key", key, "--allow-untrusted-key", f.release]);
  expect(signing.status).toBe(0);
  const pem = readFileSync(key, "utf8");
  const body = pem.split("\n").slice(1, -2).join("");
  const der = createPrivateKey(pem).export({ type: "pkcs8", format: "der" });
  const seed = der.subarray(der.length - 32);
  for (const output of [generated.output, signing.output]) {
    expect(output).not.toContain(pem);
    expect(output).not.toContain(body);
    expect(output).not.toContain("PRIVATE KEY");
    for (const encoding of ["base64", "base64url", "hex"] as const) expect(output).not.toContain(seed.toString(encoding));
  }
  return { ...f, key, publicKey };
}
test("CLI assembles, generates an owner-only key, signs and verifies without printing private material", () => {
  const f = signed();
  if (process.platform !== "win32") expect(statSync(f.key).mode & 0o777).toBe(0o600);
  const result = run(f.dir, ["verify", f.release, "--public-key", f.publicKey]);
  expect(result.status).toBe(0);
  expect(result.output).toContain("signature: OK");
  expect(result.output).toContain(`${linuxFile} size: OK`);
  expect(result.output).toContain(`${windowsFile} sha512: OK`);
  expect(result.output).toContain("platforms: linux, win32");
  expect(result.output).not.toContain(readFileSync(f.key, "utf8"));
  expect(result.output).not.toContain("PRIVATE KEY");
});
test.each(["hash", "size"])("CLI verify refuses installer %s tampering", (kind) => {
  const f = signed();
  const file = path.join(f.release, linuxFile);
  const bytes = readFileSync(file);
  if (kind === "hash") { bytes[0] = bytes[0]! ^ 1; writeFileSync(file, bytes); }
  else writeFileSync(file, Buffer.concat([bytes, Buffer.from("x")]));
  const result = run(f.dir, ["verify", f.release, "--public-key", f.publicKey]);
  expect(result.status).toBe(1);
  expect(result.output).toContain(kind === "hash" ? "sha512 mismatch" : "size mismatch");
});
test.each(["commit", "version", "duplicate", "missing", "bytes", "occupied"])("assemble refuses %s disagreement", (cause) => {
  const f = fixture();
  const data: unknown = JSON.parse(readFileSync(f.windows, "utf8"));
  if (typeof data !== "object" || data === null) throw new Error("fixture");
  if (cause === "commit") writeFileSync(f.windows, JSON.stringify({ ...data, commit: "b".repeat(40) }));
  if (cause === "version") {
    const file = "Gates-Local-1.2.4-Setup-x64.exe";
    writeFileSync(path.join(f.dir, file), "fake installer");
    writeFileSync(f.windows, JSON.stringify({ ...data, version: "1.2.4", file }));
  }
  if (cause === "bytes") writeFileSync(path.join(f.dir, windowsFile), "wrong");
  if (cause === "occupied") { mkdirSync(f.release); writeFileSync(path.join(f.release, "release.json"), "retained"); }
  const records = cause === "missing" ? [f.linux] : cause === "duplicate" ? [f.linux, f.linux] : [f.linux, f.windows];
  const result = run(f.dir, ["assemble", "--out", f.release, ...records]);
  expect(result.status).toBe(1);
  expect(result.output).toContain({ commit: "commit", version: "version", duplicate: "duplicate", missing: "missing", bytes: "size mismatch", occupied: "already" }[cause]);
  if (cause !== "occupied") expect(existsSync(f.release)).toBe(false);
});
test("assemble explicitly allows and labels one-platform output; refuses to overwrite", () => {
  const f = fixture();
  const args = ["assemble", "--allow-single-platform", "--out", f.release, f.linux];
  expect(run(f.dir, args)).toMatchObject({ status: 0, output: expect.stringContaining("one-platform") });
  expect(run(f.dir, args)).toMatchObject({ status: 1, output: expect.stringContaining("already") });
  expect(run(f.dir, ["verify", f.release])).toMatchObject({ status: 1, output: expect.stringContaining("signature") });
});
test("keygen and sign refuse key paths inside a git checkout and never print private key material", () => {
  const dir = scratch();
  const repo = path.join(dir, "repo"); mkdirSync(repo);
  execFileSync("git", ["init", "-q", repo]);
  const key = path.join(repo, "private.pem");
  const pair = generateKeyPairSync("ed25519");
  const pem = pair.privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  const generated = run(dir, ["keygen", "--out", key]);
  expect(generated).toMatchObject({ status: 1, output: expect.stringContaining("git checkout") });
  expect(existsSync(key)).toBe(false);
  // Only this disposable scratch checkout receives a generated test key.
  writeFileSync(key, pem, { mode: 0o600 });
  const sign = run(dir, ["sign", "--key", key, dir]);
  expect(sign).toMatchObject({ status: 1, output: expect.stringContaining("git checkout") });
  for (const result of [generated, sign]) { expect(result.output).not.toContain(pem); expect(result.output).not.toContain("PRIVATE KEY"); }
});
test("keygen refuses overwrite and sign refuses a key readable by others", () => {
  const f = signed();
  const pem = readFileSync(f.key, "utf8");
  const repeat = run(f.dir, ["keygen", "--out", f.key]);
  expect(repeat).toMatchObject({ status: 1, output: expect.stringContaining("exists") });
  expect(readFileSync(f.key, "utf8")).toBe(pem);
  if (process.platform !== "win32") {
    chmodSync(f.key, 0o644);
    const result = run(f.dir, ["sign", "--key", f.key, f.release]);
    expect(result).toMatchObject({ status: 1, output: expect.stringContaining("readable by others") });
    expect(result.output).not.toContain(pem);
  }
});
test("artifact uses the native packager and records only a successful clean build", () => {
  const dir = scratch();
  const repo = path.join(dir, "repo"); mkdirSync(repo);
  execFileSync("git", ["init", "-q", repo]);
  execFileSync("git", ["-C", repo, "-c", "user.name=Release test", "-c", "user.email=fixture", "commit", "--allow-empty", "-qm", "fixture"]);
  const packagerFile = packager(dir);
  writeFileSync(path.join(repo, ".gitignore"), "dist/\n");
  execFileSync("git", ["-C", repo, "add", ".gitignore"]);
  execFileSync("git", ["-C", repo, "-c", "user.name=Release test", "-c", "user.email=fixture", "commit", "-qm", "ignore outputs"]);
  const args = ["artifact", "--version", "1.2.3"];
  const env = { npm_execpath: packagerFile };
  const file = process.platform === "win32" ? "Gates-Local-1.2.3-Setup-x64.exe" : "Gates-Local-1.2.3-x86_64.AppImage";
  const output = path.join(repo, "dist", "installer", file + ".record.json");
  expect(run(repo, args, { ...env, FAKE_EXIT: "1" })).toMatchObject({ status: 1, output: expect.stringContaining("packaging failed") });
  expect(existsSync(output)).toBe(false);
  const archive = path.join(repo, "dist", "_archive"); mkdirSync(archive);
  renameSync(path.join(repo, "dist", "installer", file), path.join(archive, file));
  expect(run(repo, args, env)).toMatchObject({ status: 0, output: expect.stringContaining("record:") });
  const data: unknown = JSON.parse(readFileSync(output, "utf8"));
  expect(data).toMatchObject({ platform: process.platform, arch: "x64", size: 9, version: "1.2.3", commitFrom: "git", commit: execFileSync("git", ["-C", repo, "rev-parse", "HEAD"], { encoding: "utf8" }).trim() });
  expect(run(repo, args, { ...env, FAKE_EXIT: "1" })).toMatchObject({ status: 1, output: expect.stringContaining("record already exists") });
  expect(run(repo, ["artifact", "--version", "v1.2.3"], env)).toMatchObject({ status: 1, output: expect.stringContaining("version") });
  writeFileSync(path.join(repo, "dirty"), "changed");
  expect(run(repo, args, env)).toMatchObject({ status: 1, output: expect.stringContaining("untracked or changed files") });
});
