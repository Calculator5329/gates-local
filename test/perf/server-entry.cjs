// Test-only import counters, before the real server entry. The ready-line
// observer records numbers only, never a token or request payload.
const { appendFileSync, writeFileSync } = require("node:fs");
const { registerHooks } = require("node:module");
const path = require("node:path");
const profile = process.env.GL_PERF_DESKTOP_PROFILE;
let profiler;
if (profile) {
  const { Session } = require("node:inspector");
  profiler = new Session();
  profiler.connect();
  profiler.post("Profiler.enable");
  profiler.post("Profiler.start");
}
let modules = 0, typescript = 0, loadMs = 0;
registerHooks({ load(url, context, next) {
  const started = performance.now();
  const result = next(url, context);
  modules++;
  if (url.endsWith(".ts")) typescript++;
  loadMs += performance.now() - started;
  return result;
} });
const write = process.stdout.write.bind(process.stdout);
process.stdout.write = function (chunk, ...args) {
  if (String(chunk).includes('"ready":true')) {
    appendFileSync(process.env.GL_PERF_DESKTOP_EVENTS,
      JSON.stringify({ name: "server-imports", at: performance.timeOrigin + performance.now(), modules, typescript, loadMs }) + "\n");
    const session = profiler;
    profiler = undefined;
    session?.post("Profiler.stop", (error, result) => {
      if (error) throw error;
      writeFileSync(path.join(profile, `server-${process.pid}.cpuprofile`), JSON.stringify(result.profile), { flag: "wx" });
      session.disconnect();
    });
  }
  return write(chunk, ...args);
};
