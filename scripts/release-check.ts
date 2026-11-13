import { homedir } from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";
import { missingHostTools, runReleaseCheck } from "./release.ts";

const abort = new AbortController();
const interrupt = () => abort.abort();
process.once("SIGINT", interrupt);
process.once("SIGTERM", interrupt);
try {
  const { values } = parseArgs({ options: {
    remote: { type: "string" }, commit: { type: "string" }, report: { type: "string" },
    "store-dir": { type: "string" }, "browser-path": { type: "string" },
    "performance-base": { type: "string" },
  } });
  const reportPath = path.resolve(values.report ?? path.join(homedir(), ".cache", "gates-local-release", `report-${Date.now()}.json`));
  const report = await runReleaseCheck({ cwd: process.cwd(), remote: values.remote, commit: values.commit, reportPath, storeDir: values["store-dir"], browserPath: values["browser-path"], performanceBase: values["performance-base"], signal: abort.signal, hostTools: missingHostTools });
  console.log(`Release check ${report.status}: ${reportPath} (${(report.durationMs / 1000).toFixed(1)}s)`);
  console.log(`Performance comparison: ${JSON.stringify(report.performance ?? { status: "unavailable", note: "Correctness checks did not complete." })}`);
  process.exitCode = abort.signal.aborted ? 130 : report.status === "passed" ? 0 : 1;
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
} finally {
  process.removeListener("SIGINT", interrupt);
  process.removeListener("SIGTERM", interrupt);
}
