import base from "./playwright.config.ts";

// The same browser, stack and fixtures, with the journeys that also record cost.
// A run inside a limit (limits.ts) is slower by design, so it and the start of
// its servers get longer.
const limited = Boolean(process.env["GL_PERF_LIMIT"]);
const servers = [base.webServer ?? []].flat().map(server => limited ? { ...server, timeout: 120_000 } : server);
export default { ...base, testMatch: "next.spec.ts", timeout: limited ? 900_000 : 300_000, webServer: servers };
