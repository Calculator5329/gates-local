import base from "./playwright.config.ts";

// The same browser, stack and fixtures, with the journeys that also record cost.
// A run inside a limit (limits.ts) is slower by design, so it and the start of
// its servers get longer.
const limited = Boolean(process.env["GL_PERF_LIMIT"]);
const servers = [base.webServer ?? []].flat().map(server => limited ? { ...server, timeout: 120_000 } : server);
// why: one test holds every repetition, and a release without windowing mounts all 2000 turns
const perSample = limited ? 900_000 : 300_000;
const samples = Math.max(1, Number(process.env["GL_PERF_SAMPLES"] ?? "1"));
export default { ...base, testMatch: "next.spec.ts", timeout: perSample * samples, webServer: servers };
