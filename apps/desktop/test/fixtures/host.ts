// Stand-in for Electron main in the parent-death test: runs a supervisor,
// prints the server pid, then waits to be SIGKILLed by the test.

import { Supervisor } from "../../src/supervisor.ts";

const [entry, dataDir] = process.argv.slice(2);
if (entry === undefined || dataDir === undefined) process.exit(2);

const supervisor = new Supervisor({ entry, dataDir, env: { ...process.env, FAKE_MODE: "ready" }, log: () => {} });
const state = await supervisor.start();
process.stdout.write(`${JSON.stringify({ status: state.status, pid: supervisor.pid })}\n`);
setInterval(() => {}, 1000);
