// A separate, explicitly profiled launch. Its samples never enter comparisons.
import path from "node:path";
import { parseArgs } from "node:util";
import { ROOT } from "../e2e/env.ts";
import { prepareFixture } from "./fixture.ts";
import { desktopLaunchTimes } from "./desktop-launch.ts";

const { values } = parseArgs({ options: { out: { type: "string" } } });
if (!values.out) throw new Error("Use --out with a fresh diagnostic directory");
process.env["GL_PERF_DESKTOP_PROFILE"] = "1";
const fixture = await prepareFixture(ROOT);
console.log(await desktopLaunchTimes(ROOT, fixture, 1, path.resolve(values.out), new AbortController().signal));
