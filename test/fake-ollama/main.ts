// CLI for the fake Ollama: node test/fake-ollama/main.ts --port <n> [--scenario <name>] [--gpu-state <file>]
// Prints `fake ollama on <url>` once listening; exits on SIGTERM or SIGINT.
import { parseArgs } from "node:util";
import { SCENARIOS, startFakeOllama, type Scenario } from "./fake-ollama.ts";

const { values } = parseArgs({
  options: {
    port: { type: "string", default: "0" },
    scenario: { type: "string", default: "models" },
    "gpu-state": { type: "string" },
    "token-delay": { type: "string" },
  },
  strict: true,
});

const scenario = values.scenario;
if (!(SCENARIOS as readonly string[]).includes(scenario)) {
  process.stderr.write(`--scenario must be one of ${SCENARIOS.join(", ")}\n`);
  process.exit(2);
}
const gpuStateFile = values["gpu-state"] ?? process.env["GATES_LOCAL_FAKE_GPU_STATE"];
const tokenDelay = values["token-delay"];

const fake = await startFakeOllama({
  port: Number(values.port),
  scenario: scenario as Scenario,
  ...(gpuStateFile ? { gpuStateFile } : {}),
  ...(tokenDelay ? { options: { tokenDelayMs: Number(tokenDelay) } } : {}),
});
process.stdout.write(`fake ollama on ${fake.url}\n`);

const stop = () => void fake.close().then(() => process.exit(0));
process.on("SIGTERM", stop);
process.on("SIGINT", stop);
