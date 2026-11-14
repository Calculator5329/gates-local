// pnpm measure-models: run Measure on installed models through a running Gates Local server and
// write what it found as JSON. It goes through the app's own socket, so a model is checked the way
// the Measure button checks it: the chat's window and tool loop on Measure's fixture Library.
//
//   node scripts/measure-models.ts --server "ws://127.0.0.1:<port>/?token=<token>" --out measures.json [model...]
//
// With no model named, every installed chat model is measured, one after another. The token is
// the server's per-launch token; GATES_LOCAL_SERVER_TOKEN is used when the URL has none. Pages
// are graded by the app's window: with the window open they finish within the run; without it
// the server waits 30 seconds, then saves the measure with its pages waiting, and the score
// leaves Pages out until a window runs them.
import { writeFileSync } from "node:fs";
import { type ModelMeasure, type MeasureRun, createClient } from "@gates-local/contracts";

function usage(why: string): never {
  console.error(`${why}\nusage: node scripts/measure-models.ts --server <ws url> --out <file.json> [model...]`);
  process.exit(2);
}

const args = process.argv.slice(2);
let server: string | undefined;
let out: string | undefined;
const named: string[] = [];
for (let i = 0; i < args.length; i += 1) {
  const a = args[i]!;
  if (a === "--server") server = args[++i];
  else if (a === "--out") out = args[++i];
  else if (a.startsWith("--")) usage(`unknown option ${a}`);
  else named.push(a);
}
if (!server) usage("--server is required");
if (!out) usage("--out is required");

const url = new URL(server);
const token = process.env["GATES_LOCAL_SERVER_TOKEN"];
if (!url.searchParams.has("token") && token) url.searchParams.set("token", token);

const socket = new WebSocket(url);
const client = createClient(socket, { timeoutMs: 60_000, onProtocolError: (e) => console.error(`protocol: ${e.code}`) });
const opened = await new Promise<boolean>((resolve) => {
  socket.addEventListener("open", () => resolve(true));
  socket.addEventListener("close", () => resolve(false));
});
if (!opened) usage(`could not connect to ${url.host} (is the server running, and is the token right?)`);
await client.negotiate();

const runs = new Map<string, (run: MeasureRun) => void>();
client.subscribe("models.measuring", (run) => runs.get(run.model)?.(run));

/** One model's measure: the run's end comes on models.measuring, its numbers from models.measures. */
async function measure(model: string): Promise<{ model: string; measure?: ModelMeasure; error?: string; ms: number }> {
  const started = Date.now();
  const ended = new Promise<MeasureRun>((resolve) => {
    runs.set(model, (run) => {
      if (run.state === "running") process.stderr.write(`\r${model}: ${run.done} of ${run.total}   `);
      if (run.state === "done" || run.state === "error") resolve(run);
    });
  });
  try {
    await client.call("models.measure", { name: model });
    const run = await ended;
    process.stderr.write("\n");
    if (run.state === "error") return { model, error: run.message ?? "The measure failed.", ms: Date.now() - started };
    const kept = (await client.call("models.measures", {})).filter((m) => m.model === model).toSorted((a, b) => b.at - a.at)[0];
    return kept ? { model, measure: kept, ms: Date.now() - started } : { model, error: "The server kept no measure.", ms: Date.now() - started };
  } catch (e) {
    return { model, error: e instanceof Error ? e.message : String(e), ms: Date.now() - started };
  } finally {
    runs.delete(model);
  }
}

const models = named.length > 0 ? named : (await client.call("models.list", {})).filter((m) => m.capabilities.includes("completion")).map((m) => m.name);
if (models.length === 0) usage("no installed chat model to measure");
const results = [];
for (const model of models) {
  const r = await measure(model);
  const m = r.measure;
  console.log(m ? `${model}: score ${m.score}, ${m.tokensPerSecond.toFixed(1)} tok/s${m.slow ? ` (slow: ${m.slow})` : ""}${m.checks.some((c) => c.state === "pending") ? ", pages waiting for a window" : ""}, ${Math.round(r.ms / 1000)} s` : `${model}: ${r.error}`);
  results.push(r);
}
writeFileSync(out, `${JSON.stringify({ at: Date.now(), results }, null, 2)}\n`);
console.log(`wrote ${out}`);
client.close();
