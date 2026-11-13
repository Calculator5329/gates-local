// Build an offline-installable AppImage or NSIS installer. Staging stays in the user's cache;
// only the distributable and builder reports go to the ignored dist folder.
import "./build.ts";
import { build as bundle } from "esbuild";
import { build as packageApp, Platform } from "electron-builder";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { createRequire } from "node:module";
import path from "node:path";

const desktop = path.resolve(import.meta.dirname, "..");
const repo = path.resolve(desktop, "..", "..");
const windows = process.argv.includes("--win");
const cache = path.join(homedir(), ".cache", "gates-local-packaging");
mkdirSync(cache, { recursive: true });
const stage = mkdtempSync(path.join(cache, "build-"));
const appDir = path.join(stage, "app");
const server = path.join(stage, "server");
mkdirSync(appDir);
mkdirSync(server);
const desktopRequire = createRequire(import.meta.url);
const electronPackage = JSON.parse(readFileSync(desktopRequire.resolve("electron/package.json"), "utf8")) as { version: string };
// A development build version, not a release tag. Supply a release version
// only when the corresponding release has been authorized.
const version = process.env["GATES_LOCAL_BUILD_VERSION"] ?? "0.0.0-dev";
writeFileSync(path.join(appDir, "package.json"), JSON.stringify({ name: "gates-local", version, private: true, main: "out/main.cjs", desktopName: "gates-local.desktop", description: "Local AI on your computer", author: "Gates Local contributors", license: "MIT" }));
cpSync(path.join(desktop, "out"), path.join(appDir, "out"), { recursive: true });
cpSync(path.join(repo, "LICENSE"), path.join(appDir, "LICENSE"));
const serverRequire = createRequire(path.join(repo, "apps/server/package.json"));
const webRequire = createRequire(path.join(repo, "apps/web/package.json"));
const domRequire = createRequire(webRequire.resolve("react-dom/package.json"));
const notices = [[serverRequire, "effect"], [serverRequire, "ws"], [serverRequire, "@jsquash/webp"], [serverRequire, "pngjs"], [webRequire, "react"], [webRequire, "react-dom"], [domRequire, "scheduler"]] as const;
// The thumbnail encoder is libwebp compiled to WebAssembly: one .wasm for every platform, read from beside
// the bundle (apps/server/src/pictures/thumbs.ts), with libwebp's own notice.
const webp = path.dirname(serverRequire.resolve("@jsquash/webp/package.json"));
writeFileSync(path.join(appDir, "THIRD-PARTY-NOTICES.txt"), [
  ...notices.map(([resolveFrom, name]) => `${name}\n${readFileSync(path.join(path.dirname(resolveFrom.resolve(`${name}/package.json`)), "LICENSE"), "utf8")}`),
  `libwebp (in @jsquash/webp)\n${readFileSync(path.join(webp, "codec", "LICENSE.codec.md"), "utf8")}`,
].join("\n\n"));
writeFileSync(path.join(server, "package.json"), '{"type":"module"}\n');
cpSync(path.join(webp, "codec", "enc", "webp_enc_simd.wasm"), path.join(server, "webp_enc_simd.wasm"));
// GATES_LOCAL_TEST_BUILD=1 marks a test build: only a copy holding
// resources/test-build.json reads GATES_LOCAL_UPDATE_TEST_KEYS and accepts a
// loopback update feed (apps/server/src/update/installed/module.ts).
// release:artifact refuses to run with the variable set.
const testBuild = process.env["GATES_LOCAL_TEST_BUILD"] === "1";
const marker = path.join(stage, "test-build.json");
if (testBuild) {
  writeFileSync(marker, JSON.stringify({ testBuild: true, note: "Accepts test release keys and a loopback update feed. Never release this build." }, null, 2) + "\n");
  console.log("Packaging a test build: resources/test-build.json is included.");
}

// ws has optional native accelerators; its portable JS path needs no native
// rebuild. createRequire supports bundled CommonJS dependencies in this ESM.
for (const [entry, output] of [["main.ts", "main.mjs"], ["sources/git-worker.ts", "git-worker.ts"]] as const) {
  await bundle({
    entryPoints: [path.join(repo, "apps/server/src", entry)],
    outfile: path.join(server, output),
    bundle: true, platform: "node", format: "esm", target: "node24",
    external: ["bufferutil", "utf-8-validate"],
    banner: { js: 'import { createRequire as __createRequire } from "node:module"; const require = __createRequire(import.meta.url);' },
    logLevel: "info",
  });
}

await packageApp({
  targets: windows ? Platform.WINDOWS.createTarget("nsis") : Platform.LINUX.createTarget("AppImage"),
  publish: "never",
  config: {
    appId: "org.gateslocal.desktop", productName: "Gates Local",
    electronVersion: electronPackage.version,
    directories: { app: appDir, output: path.join(repo, "dist", "installer") },
    files: ["out/*.cjs", "LICENSE", "THIRD-PARTY-NOTICES.txt", "package.json"],
    extraResources: [
      { from: server, to: "server" },
      { from: path.join(repo, "apps/web/dist"), to: "web" },
      { from: path.join(desktop, "assets/icon.png"), to: "icon.png" },
      ...(testBuild ? [{ from: marker, to: "test-build.json" }] : []),
    ],
    asar: true, npmRebuild: false,
    linux: { category: "Utility", executableName: "gates-local", icon: path.join(desktop, "assets/icon.png"), syncDesktopName: true },
    win: { icon: path.join(desktop, "assets/icon.png"), signExecutable: false },
    nsis: { oneClick: true, perMachine: false, allowElevation: false, packElevateHelper: false, deleteAppDataOnUninstall: false, runAfterFinish: true },
    // Linux cross-builds need Wine to extract NSIS's generated uninstaller.
    // This is a build tool only; it is not shipped or used to test Windows.
    toolsets: { wine: "1.0.1" },
    artifactName: windows ? "Gates-Local-${version}-Setup-${arch}.${ext}" : "Gates-Local-${version}-${arch}.${ext}",
  },
});
