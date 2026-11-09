// Test-only observer loaded before the built main, using the existing Electron
// launch seam. The shipped app has no timing hook. Never record the server URL.
const { createRequire, syncBuiltinESMExports } = require("node:module");
const path = require("node:path");
const { app, session } = createRequire(path.join(process.env.GL_PERF_TARGET, "apps/desktop/package.json"))("electron");
const { appendFileSync } = require("node:fs");
const childProcess = require("node:child_process");
const stamp = (name, details = {}) => appendFileSync(process.env.GL_PERF_DESKTOP_EVENTS, JSON.stringify({ name, at: performance.timeOrigin + performance.now(), ...details }) + "\n");
stamp("main-entry", { versions: { electron: process.versions.electron, node: process.versions.node, chrome: process.versions.chrome } });
app.once("ready", () => stamp("app-ready"));
// Register before the built main's whenReady callback creates its window.
// A debugger command awaited before the first navigation can deadlock an
// uninitialized renderer; a session preload needs no debugger attachment.
app.whenReady().then(() => session.defaultSession.registerPreloadScript({ type: "frame", filePath: process.env.GL_PERF_DESKTOP_RENDERER }));
app.on("browser-window-created", (_event, window) => {
  stamp("window-created");
  if (window.isVisible()) stamp("window-shown");
  else window.once("show", () => stamp("window-shown"));
});
const spawn = childProcess.spawn;
childProcess.spawn = function (file, args, options) {
  if (!args.includes("--data-dir")) return spawn(file, args, options);
  stamp("server-spawn");
  const observe = ["--require", process.env.GL_PERF_DESKTOP_SERVER_PROBE, ...args];
  const child = spawn(file, observe, options);
  let output = "";
  child.stdout.on("data", chunk => {
    output += chunk.toString();
    if (output.includes('"ready":true')) { stamp("server-ready"); output = ""; }
  });
  return child;
};
syncBuiltinESMExports();
require(path.join(process.env.GL_PERF_TARGET, "apps/desktop/out/main.cjs"));
