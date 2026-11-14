import { appendFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { observeServerStages } from "./server-stages.ts";

const require = createRequire(path.join(process.env["GL_PERF_TARGET"]!, "apps/server/package.json"));
const { WebSocket } = require("ws");
observeServerStages(WebSocket.prototype, record => {
  appendFileSync(path.join(process.env["GL_PERF_OUT"]!, "server-stages.jsonl"), JSON.stringify(record) + "\n");
});
