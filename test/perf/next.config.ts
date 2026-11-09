import base from "./playwright.config.ts";

// The same browser, stack and fixtures, with the journeys that also record cost.
export default { ...base, testMatch: "next.spec.ts", timeout: 300_000 };
