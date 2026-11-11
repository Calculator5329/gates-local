import base from "./playwright.config.ts";

// The same browser, stack and fixtures, with the journeys that also record cost.
// A run inside a limit (limits.ts) is slower by design, so it gets longer.
export default { ...base, testMatch: "next.spec.ts", timeout: process.env["GL_PERF_LIMIT"] ? 900_000 : 300_000 };
