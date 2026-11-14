import { execFileSync, spawn } from "node:child_process";
import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, type KeyObject } from "node:crypto";
import { constants, copyFileSync, createReadStream, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { FEED_LIMITS } from "../apps/server/src/update/installed/feed.ts";
import { encodeModelsFile, MODELS_FILE, MODELS_SIGNATURE_FILE, parseModelsFile } from "../apps/server/src/update/installed/models-list.ts";
import { encodeManifest, parseManifest, signManifest, TRUSTED_RELEASE_KEYS, validateReleaseVersion, verifyManifest, verifySigned, type ReleaseArtifact, type ReleaseManifest } from "../apps/server/src/update/release-manifest.ts";
import { parseChatModels } from "../packages/contracts/src/chat-models.ts";

const LIST_PATH = "packages/contracts/src/chat-models.json";

interface ArtifactRecord extends ReleaseArtifact { version: string; commit: string; commitFrom: "git" | "given" }

function git(cwd: string, args: string[]) {
  return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}
function cleanCommit(cwd: string) {
  if (git(cwd, ["status", "--porcelain"])) throw new Error("Refusing a checkout with untracked or changed files; commit them or move them out first");
  return git(cwd, ["rev-parse", "HEAD"]);
}
async function hashFile(file: string) {
  if (!lstatSync(file).isFile()) throw new Error(`${path.basename(file)} must be a regular file, not a link or directory`);
  const hash = createHash("sha512");
  let size = 0;
  for await (const chunk of createReadStream(file)) { size += chunk.length; hash.update(chunk); }
  return { size, sha512: hash.digest("hex") };
}
async function checkFile(dir: string, artifact: ReleaseArtifact, report = false) {
  const actual = await hashFile(path.join(dir, artifact.file));
  if (actual.size !== artifact.size) throw new Error(`${artifact.file} size mismatch: expected ${artifact.size}, got ${actual.size}`);
  if (report) console.log(`${artifact.file} size: OK (${actual.size} bytes)`);
  if (actual.sha512 !== artifact.sha512) throw new Error(`${artifact.file} sha512 mismatch`);
  if (report) console.log(`${artifact.file} sha512: OK`);
}
function readRecord(file: string): ArtifactRecord {
  const input: unknown = JSON.parse(readFileSync(file, "utf8"));
  if (typeof input !== "object" || input === null || Array.isArray(input)) throw new Error("artifact record must be an object");
  const row: Record<string, unknown> = Object.fromEntries(Object.entries(input));
  const { version, commit, commitFrom, ...artifact } = row;
  if (commitFrom !== "git" && commitFrom !== "given") throw new Error("record.commitFrom must be git or given");
  const manifest = parseManifest(encodeManifest({ schema: 1, version, commit, artifacts: [artifact] }));
  const item = manifest.artifacts[0];
  if (!item) throw new Error("artifact record is missing its artifact");
  return { ...item, version: manifest.version, commit: manifest.commit, commitFrom };
}

function checkParents(start: string) {
  let current = start;
  while (true) {
    if (existsSync(path.join(current, ".git"))) throw new Error("Release key must be outside any git checkout");
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
}
// Resolve existing ancestors too, so a symlink cannot place a key in a checkout.
function outsideCheckout(file: string) {
  checkParents(path.dirname(file));
  let existing = file;
  while (!existsSync(existing)) {
    const parent = path.dirname(existing);
    if (parent === existing) throw new Error("Cannot resolve release key path");
    existing = parent;
  }
  checkParents(lstatSync(existing).isDirectory() ? realpathSync(existing) : path.dirname(realpathSync(existing)));
}
function required(value: string | undefined, flag: string) {
  if (!value) throw new Error(`${flag} is required`);
  return value;
}
function count(positionals: string[], length: number, usage: string) {
  if (positionals.length !== length) throw new Error(`Usage: ${usage}`);
}

async function buildArtifact(args: string[]) {
  // An artifact record is the only way into a release list, so a test build can never be listed.
  if (process.env["GATES_LOCAL_TEST_BUILD"] !== undefined) throw new Error("GATES_LOCAL_TEST_BUILD is set. A test build trusts test keys and a loopback feed, so it can never be released. Unset it and run release:artifact again.");
  const { values, positionals } = parseArgs({ args, options: { version: { type: "string" }, commit: { type: "string" } } });
  count(positionals, 0, "release:artifact --version X.Y.Z [--commit COMMIT]");
  const version = validateReleaseVersion(required(values.version, "--version"));
  if ((process.platform !== "linux" && process.platform !== "win32") || process.arch !== "x64") throw new Error("release:artifact supports native Linux x64 and Windows x64 only");
  const cwd = process.cwd();
  if (values.commit !== undefined && !/^[a-f0-9]{40}$/.test(values.commit)) throw new Error("--commit must be 40 lowercase hex characters");
  const commitFrom = existsSync(path.join(cwd, ".git")) ? "git" : "given";
  const commit = commitFrom === "git" ? cleanCommit(cwd) : required(values.commit, "--commit for exported source");
  if (commitFrom === "git" && values.commit !== undefined && values.commit !== commit) throw new Error("--commit does not match HEAD");
  const file = process.platform === "win32" ? `Gates-Local-${version}-Setup-x64.exe` : `Gates-Local-${version}-x86_64.AppImage`;
  const output = path.join(cwd, "dist", "installer", file);
  const recordFile = output + ".record.json";
  if (existsSync(recordFile)) throw new Error("Artifact record already exists; archive the previous installer and record before rebuilding");
  if (existsSync(output)) throw new Error("Output installer already exists; archive it and its record first");
  const pnpm = process.env["npm_execpath"];
  if (!pnpm) throw new Error("Run this command through pnpm release:artifact so the native pnpm entry point is available");
  const command = process.platform === "win32" ? "package:win" : "package:linux";
  const extension = path.extname(pnpm).toLowerCase();
  if (extension === ".cmd" || extension === ".bat") throw new Error("pnpm must be a JavaScript entry point or native executable; .cmd and .bat wrappers require a shell and are refused");
  const javascript = [".js", ".cjs", ".mjs"].includes(extension);
  await new Promise<void>((resolve, reject) => {
    const child = spawn(javascript ? process.execPath : pnpm, javascript ? [pnpm, command] : [command], { cwd, stdio: "inherit", env: { ...process.env, GATES_LOCAL_BUILD_VERSION: version } });
    child.once("error", reject);
    child.once("close", (code, signal) => code === 0 ? resolve() : reject(new Error(`packaging failed (${code ?? signal}); no artifact record written`)));
  });
  if (!existsSync(output)) throw new Error("Packaging exited zero but did not produce the expected installer; no artifact record written");
  if (commitFrom === "git") {
    // A new commit or a tracked edit while packaging means the installer may not be this commit's.
    let after: string | null;
    try { after = cleanCommit(cwd); } catch { after = null; }
    if (after !== commit) throw new Error("The checkout changed during packaging; no artifact record written");
  }
  const record: ArtifactRecord = { platform: process.platform, arch: process.arch, kind: process.platform === "win32" ? "nsis" : "appimage", file, ...await hashFile(output), version, commit, commitFrom };
  encodeManifest({ schema: 1, version, commit, artifacts: [{ platform: record.platform, arch: record.arch, kind: record.kind, file, size: record.size, sha512: record.sha512 }] });
  writeFileSync(recordFile, JSON.stringify(record, null, 2) + "\n", { flag: "wx" });
  console.log(`artifact: ${output} (${record.size} bytes)`);
  console.log(`record: ${recordFile}`);
  console.log(`version: ${version}; commit: ${commit}`);
  console.log(commitFrom === "given" ? "commit was given, not read from Git" : "commit was read from Git");
}

async function assemble(args: string[]) {
  const { values, positionals } = parseArgs({ args, allowPositionals: true, options: { out: { type: "string" }, "allow-single-platform": { type: "boolean", default: false } } });
  const out = path.resolve(required(values.out, "--out"));
  if (positionals.length === 0) throw new Error("At least one artifact record is required");
  if (existsSync(out)) throw new Error("Output directory already exists; choose a new release directory");
  const records = positionals.map((file) => ({ source: path.resolve(file), record: readRecord(file) }));
  const first = records[0];
  if (!first) throw new Error("At least one artifact record is required");
  for (const { record } of records) {
    if (record.commit !== first.record.commit) throw new Error("Artifact records disagree on commit");
    if (record.version !== first.record.version) throw new Error("Artifact records disagree on version");
  }
  const artifacts = records.map(({ record: { version: _version, commit: _commit, commitFrom: _commitFrom, ...item } }) => item).toSorted((a, b) => a.platform.localeCompare(b.platform));
  const manifest = encodeManifest({ schema: 1, version: first.record.version, commit: first.record.commit, artifacts });
  const platforms = new Set(artifacts.map((item) => item.platform));
  if (platforms.size !== 2 && !values["allow-single-platform"]) throw new Error("Release is missing a platform; provide linux and win32 records or explicitly use --allow-single-platform");
  for (const { source, record } of records) {
    console.log(`${path.basename(source)} commit source: ${record.commitFrom}`);
    await checkFile(path.dirname(source), record);
  }
  mkdirSync(path.dirname(out), { recursive: true });
  const partial = mkdtempSync(path.join(path.dirname(out), `.${path.basename(out)}.partial-`));
  try {
    for (const { source, record } of records) {
      copyFileSync(path.join(path.dirname(source), record.file), path.join(partial, record.file), constants.COPYFILE_EXCL);
      await checkFile(partial, record);
    }
    writeFileSync(path.join(partial, "release.json"), manifest, { flag: "wx" });
    renameSync(partial, out);
  } catch (error) {
    console.error(`Partial release retained at: ${partial}`);
    throw error;
  }
  console.log(`assembled: ${out} (${platforms.size === 1 ? "one-platform set; incomplete release" : "linux + win32"})`);
}

function keygen(args: string[]) {
  const { values, positionals } = parseArgs({ args, options: { out: { type: "string" } } });
  count(positionals, 0, "release:keygen --out FILE");
  const file = path.resolve(required(values.out, "--out"));
  outsideCheckout(file);
  if (existsSync(file)) throw new Error("Release key file already exists; refusing to overwrite");
  mkdirSync(path.dirname(file), { recursive: true });
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  writeFileSync(file, privateKey.export({ type: "pkcs8", format: "pem" }), { flag: "wx", mode: 0o600 });
  console.log(publicKey.export({ type: "spki", format: "der" }).toString("base64"));
}
function readKey(value: string | undefined) {
  const file = path.resolve(required(value, "--key"));
  outsideCheckout(file);
  const info = lstatSync(file);
  if (!info.isFile()) throw new Error("Release key must be a regular file, not a link or directory");
  if (process.platform !== "win32" && (info.mode & 0o077) !== 0) throw new Error("Release key is readable by others; restrict it to owner-only permissions (chmod 600)");
  try { return createPrivateKey(readFileSync(file)); }
  catch { throw new Error("Cannot read release private key; provide an Ed25519 PKCS8 PEM file"); }
}
async function checkTrusted(cwd: string, key: KeyObject) {
  const source: unknown = await import(pathToFileURL(path.join(cwd, "apps/server/src/update/release-manifest.ts")).href);
  if (typeof source !== "object" || source === null || !("TRUSTED_RELEASE_KEYS" in source) || !Array.isArray(source.TRUSTED_RELEASE_KEYS)) throw new Error("Checkout must export TRUSTED_RELEASE_KEYS");
  const publicKey = createPublicKey(key).export({ type: "spki", format: "der" }).toString("base64");
  if (!source.TRUSTED_RELEASE_KEYS.some((entry: unknown) => entry === publicKey)) throw new Error("Signing key is not in this checkout's TRUSTED_RELEASE_KEYS; add its public key and land that commit before building");
}
async function sign(args: string[]) {
  const { values, positionals } = parseArgs({ args, allowPositionals: true, options: { key: { type: "string" }, "allow-single-platform": { type: "boolean" }, "allow-untrusted-key": { type: "boolean" } } });
  count(positionals, 1, "release:sign --key FILE DIR");
  const key = readKey(values.key);
  const dir = path.resolve(required(positionals[0], "DIR"));
  const bytes = readFileSync(path.join(dir, "release.json"));
  const manifest = parseManifest(bytes);
  if (manifest.artifacts.length === 1 && !values["allow-single-platform"]) throw new Error("Signing a one-platform list requires --allow-single-platform");
  for (const item of manifest.artifacts) await checkFile(dir, item);
  if (values["allow-untrusted-key"]) {
    console.log("Proof signing: installed copies will not accept this signature unless they already trust this key; checkout and key trust checks skipped");
  } else {
    const cwd = process.cwd();
    if (!existsSync(path.join(cwd, ".git"))) throw new Error("Signing requires a checkout at the release commit");
    if (cleanCommit(cwd) !== manifest.commit) throw new Error("Signing checkout commit does not match release.json commit");
    await checkTrusted(cwd, key);
  }
  writeFileSync(path.join(dir, "release.json.sig"), signManifest(bytes, key), { flag: "wx" });
  console.log("release.json signature: written");
}
// The chat model list installed copies fetch beside release.json: the committed
// chat-models.json, wrapped and signed with the release key.
async function models(args: string[]) {
  const { values, positionals } = parseArgs({ args, allowPositionals: true, options: { key: { type: "string" }, "allow-untrusted-key": { type: "boolean" } } });
  count(positionals, 1, "release:models --key FILE DIR");
  const key = readKey(values.key);
  const dir = path.resolve(required(positionals[0], "DIR"));
  const cwd = process.cwd();
  const list = path.join(cwd, LIST_PATH);
  if (values["allow-untrusted-key"]) {
    console.log("Proof signing: installed copies will not accept this list unless they already trust this key; checkout and key trust checks skipped");
  } else {
    if (!existsSync(path.join(cwd, ".git"))) throw new Error("Building the model list requires a checkout holding the list to publish");
    if (git(cwd, ["status", "--porcelain", "--", LIST_PATH])) throw new Error(`${LIST_PATH} has uncommitted changes; commit it first so the published list is one a commit holds`);
    await checkTrusted(cwd, key);
  }
  const chat = parseChatModels(JSON.parse(readFileSync(list, "utf8")), LIST_PATH);
  const bytes = encodeModelsFile(chat);
  if (bytes.length > FEED_LIMITS.modelsBytes) throw new Error(`models.json is ${bytes.length} bytes; installed copies read at most ${FEED_LIMITS.modelsBytes}`);
  const target = path.join(dir, MODELS_FILE), signatureTarget = path.join(dir, MODELS_SIGNATURE_FILE);
  if (existsSync(target) || existsSync(signatureTarget)) throw new Error(`${MODELS_FILE} or its signature already exists in ${dir}; choose a new directory`);
  const signature = signManifest(bytes, key);
  verifySigned(bytes, signature, [createPublicKey(key).export({ type: "spki", format: "der" }).toString("base64")]);
  parseModelsFile(bytes);
  mkdirSync(dir, { recursive: true });
  writeFileSync(target, bytes, { flag: "wx" });
  writeFileSync(signatureTarget, signature, { flag: "wx" });
  console.log(`models.json: revision ${chat.revision}, ${chat.models.length} models, ${bytes.length} bytes`);
  console.log("models.json signature: written");
}
async function verify(args: string[]) {
  const { values, positionals } = parseArgs({ args, allowPositionals: true, options: { "public-key": { type: "string" } } });
  count(positionals, 1, "release:verify DIR [--public-key KEY]");
  const dir = path.resolve(required(positionals[0], "DIR"));
  if (values["public-key"] === "") throw new Error("--public-key must not be empty");
  const keys = values["public-key"] !== undefined ? [values["public-key"]] : TRUSTED_RELEASE_KEYS;
  const bytes = readFileSync(path.join(dir, "release.json"));
  const signatureFile = path.join(dir, "release.json.sig");
  if (!existsSync(signatureFile)) throw new Error("release.json signature is missing; sign the release directory first");
  const manifest: ReleaseManifest = verifyManifest(bytes, readFileSync(signatureFile), keys);
  console.log("release.json signature: OK");
  console.log(`release.json schema/version/commit/artifacts: OK (${manifest.version}, ${manifest.commit})`);
  console.log(`release.json platforms: ${manifest.artifacts.map((item) => item.platform).join(", ")}`);
  for (const item of manifest.artifacts) await checkFile(dir, item, true);
}

try {
  const [command, ...args] = process.argv.slice(2);
  switch (command) {
    case "artifact": await buildArtifact(args); break;
    case "assemble": await assemble(args); break;
    case "keygen": keygen(args); break;
    case "sign": await sign(args); break;
    case "verify": await verify(args); break;
    case "models": await models(args); break;
    default: throw new Error("Choose a release command: artifact, assemble, keygen, sign, verify or models");
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : "Release command failed");
  process.exitCode = 1;
}
