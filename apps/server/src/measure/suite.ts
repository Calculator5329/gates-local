// Measure (Settings › Models, row 29): a short check of one model on this computer, run only
// when the person clicks Measure. One request measures decode speed; then three tool-use
// prompts and five questions against a small built-in shop database, each one request,
// graded on the call the model makes. Nothing here takes the GPU lease or checks the fit:
// the caller does both before it calls measureModel.
import { existsSync, mkdirSync, renameSync, rmSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import path from "node:path";
import type { MeasureCheck, ModelMeasure } from "@gates-local/contracts";
import { parseTextCalls, repairCall } from "../../../../packages/harness/src/parser.ts";
import { toolBlock, type ToolDefinition } from "../../../../packages/harness/src/prompt.ts";
import { runSnapshotQuery } from "../../../../packages/harness/src/sql.ts";
import type { ToolCall } from "../../../../packages/harness/src/types.ts";

/** Every request runs at this window: small enough for any model that runs here, big enough for the schema. */
export const MEASURE_CTX = 4096;
const SPEED_PROMPT = "Describe a lighthouse at night in about 150 words.";
const SPEED_TOKENS = 200;
const CHECK_TOKENS = 400;
const QUERY_MS = 5000;

const fn = (name: string, description: string, properties: Record<string, unknown>, required: string[]): ToolDefinition =>
  ({ type: "function", function: { name, description, parameters: { type: "object", properties, required, additionalProperties: false } } });

const CHECK_TOOLS = [
  fn("get_weather", "The current weather in a city.", { city: { type: "string" } }, ["city"]),
  fn("convert_currency", "Convert an amount of money between currencies given as ISO codes such as USD.", { amount: { type: "number" }, from: { type: "string" }, to: { type: "string" } }, ["amount", "from", "to"]),
];
const SQL_TOOLS = [fn("sql", "Run one read-only SQLite query against the shop database and see its rows.", { query: { type: "string" } }, ["query"])];

const SCHEMA = `CREATE TABLE customers (id INTEGER PRIMARY KEY, name TEXT NOT NULL, city TEXT NOT NULL);
CREATE TABLE products (id INTEGER PRIMARY KEY, name TEXT NOT NULL, category TEXT NOT NULL, price REAL NOT NULL);
CREATE TABLE orders (id INTEGER PRIMARY KEY, customer_id INTEGER NOT NULL REFERENCES customers(id), ordered_on TEXT NOT NULL);
CREATE TABLE order_items (order_id INTEGER NOT NULL REFERENCES orders(id), product_id INTEGER NOT NULL REFERENCES products(id), quantity INTEGER NOT NULL);`;
const ROWS = `INSERT INTO customers VALUES (1,'Ana Silva','Lisbon'),(2,'Ben Okafor','Lagos'),(3,'Chloe Martin','Paris'),(4,'Dev Patel','Lisbon'),(5,'Eva Novak','Prague'),(6,'Finn Berg','Lisbon'),(7,'Gia Romano','Paris');
INSERT INTO products VALUES (1,'Trowel','Garden',12.5),(2,'Hose','Garden',30),(3,'Seeds','Garden',4),(4,'Lamp','Home',45),(5,'Rug','Home',80),(6,'Kettle','Kitchen',25),(7,'Pan','Kitchen',35),(8,'Knife','Kitchen',20),(9,'Mug','Kitchen',8);
INSERT INTO orders VALUES (1,1,'2024-02-11'),(2,2,'2024-03-02'),(3,1,'2024-03-15'),(4,3,'2024-03-28'),(5,4,'2024-04-03'),(6,2,'2024-04-19'),(7,5,'2024-03-09'),(8,1,'2024-05-01');
INSERT INTO order_items VALUES (1,1,2),(1,4,1),(2,5,1),(2,9,4),(3,2,1),(3,3,5),(4,6,1),(5,7,2),(5,1,1),(6,4,2),(7,8,3),(8,5,1);`;

interface Reply { content: string; calls: ToolCall[] }
type ToolCase = { id: string; kind: "tools"; prompt: string; pass: (r: Reply) => boolean };
type SqlCase = { id: string; kind: "sql"; prompt: string; answer: string | number; reference: string };
export type MeasureCase = ToolCase | SqlCase;

const only = (r: Reply, name: string) => r.calls.length === 1 && r.calls[0]!.name === name ? r.calls[0]!.input : undefined;
const said = (v: unknown, word: RegExp) => typeof v === "string" && word.test(v.trim());

export const CASES: readonly MeasureCase[] = [
  { id: "tools-weather", kind: "tools", prompt: "What's the weather like in Lisbon right now?", pass: (r) => said(only(r, "get_weather")?.city, /^lisbon\b/i) },
  {
    id: "tools-convert", kind: "tools", prompt: "How much is 250 US dollars in euros?",
    pass: (r) => { const a = only(r, "convert_currency"); return Number(a?.amount) === 250 && said(a?.from, /^usd$/i) && said(a?.to, /^eur$/i); },
  },
  { id: "tools-none", kind: "tools", prompt: "What is the capital of France? Answer in one word.", pass: (r) => r.calls.length === 0 && /paris/i.test(r.content) },
  { id: "sql-count", kind: "sql", prompt: "How many orders were placed in March 2024?", answer: 4, reference: "SELECT COUNT(*) AS n FROM orders WHERE ordered_on >= '2024-03-01' AND ordered_on < '2024-04-01'" },
  {
    id: "sql-top", kind: "sql", prompt: "Which customer has spent the most in total, counting price times quantity?", answer: "Ben Okafor",
    reference: "SELECT c.name, SUM(i.quantity * p.price) AS spent FROM customers c JOIN orders o ON o.customer_id = c.id JOIN order_items i ON i.order_id = o.id JOIN products p ON p.id = i.product_id GROUP BY c.id ORDER BY spent DESC LIMIT 1",
  },
  { id: "sql-never", kind: "sql", prompt: "How many customers have never placed an order?", answer: 2, reference: "SELECT COUNT(*) AS n FROM customers WHERE id NOT IN (SELECT customer_id FROM orders)" },
  {
    id: "sql-garden", kind: "sql", prompt: "What is the total revenue from Garden products?", answer: 87.5,
    reference: "SELECT SUM(i.quantity * p.price) AS revenue FROM order_items i JOIN products p ON p.id = i.product_id WHERE p.category = 'Garden'",
  },
  { id: "sql-city", kind: "sql", prompt: "Which city has the most customers?", answer: "Lisbon", reference: "SELECT city, COUNT(*) AS n FROM customers GROUP BY city ORDER BY n DESC LIMIT 1" },
];

/** The shop database under `dir`, built once from the schema and rows above. */
export function ensureShopDb(dir: string): string {
  const file = path.join(dir, "measure-shop-v1.db");
  if (existsSync(file)) return file;
  mkdirSync(dir, { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  rmSync(tmp, { force: true });
  const db = new DatabaseSync(tmp);
  try { db.exec(`${SCHEMA}\n${ROWS}`); } finally { db.close(); }
  renameSync(tmp, file);
  return file;
}

/** A cell that is the answer: the same number to the cent, or the same words. */
const isAnswer = (cell: unknown, answer: string | number) =>
  typeof answer === "number" ? Math.abs(Number(cell) - answer) < 0.005 : String(cell).trim().toLowerCase() === answer.toLowerCase();

export interface MeasureInput {
  baseUrl: string;
  model: string;
  signal: AbortSignal;
  /** The shop database (ensureShopDb). */
  dbFile: string;
  fetch?: typeof fetch;
  /** Steps finished so far, of total: the speed request, then each case. */
  onStep?: (done: number, total: number) => void;
  now?: () => number;
}

export async function measureModel(input: MeasureInput): Promise<Omit<ModelMeasure, "model" | "digest">> {
  const fetcher = input.fetch ?? fetch;
  const total = CASES.length + 1;
  const show = await fetcher(new URL("/api/show", input.baseUrl), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ model: input.model }), signal: input.signal });
  if (!show.ok) throw new Error(`The model's details could not be read (HTTP ${show.status})`);
  const capabilities = ((await show.json()) as { capabilities?: unknown }).capabilities;
  const has = (c: string) => Array.isArray(capabilities) && capabilities.includes(c);
  const native = has("tools");

  const ask = async (messages: { role: string; content: string }[], numPredict: number, tools?: readonly ToolDefinition[]) => {
    const response = await fetcher(new URL("/api/chat", input.baseUrl), {
      method: "POST", headers: { "content-type": "application/json" }, signal: input.signal,
      body: JSON.stringify({
        model: input.model, messages, stream: true,
        options: { num_ctx: MEASURE_CTX, temperature: 0, num_predict: numPredict },
        // A thinking model would think through every check; the measure asks for the answer.
        ...(has("thinking") ? { think: false } : {}),
        ...(tools && native ? { tools } : {}),
      }),
    });
    if (!response.ok) throw new Error(`The model did not answer (HTTP ${response.status}): ${(await response.text()).slice(0, 300)}`);
    let content = "";
    const raw: unknown[] = [];
    let figures: { eval_count?: number; eval_duration?: number } = {};
    for (const line of (await response.text()).split("\n")) {
      if (!line.trim()) continue;
      const v = JSON.parse(line) as { error?: string; done?: boolean; eval_count?: number; eval_duration?: number; message?: { content?: string; tool_calls?: unknown[] } };
      if (v.error) throw new Error(v.error);
      content += v.message?.content ?? "";
      if (Array.isArray(v.message?.tool_calls)) raw.push(...v.message.tool_calls);
      if (v.done) figures = v;
    }
    if (tools && !native) {
      const parsed = parseTextCalls(content);
      raw.push(...parsed.calls);
      content = parsed.content;
    }
    const calls = raw.flatMap((c) => { try { return [repairCall(c)]; } catch { return []; } });
    return { reply: { content, calls }, figures };
  };
  const withTools = (system: string, tools: readonly ToolDefinition[]) => native ? system : `${system}\n${toolBlock(tools)}`;

  let done = 0;
  const step = () => input.onStep?.(++done, total);
  const speed = await ask([{ role: "user", content: SPEED_PROMPT }], SPEED_TOKENS);
  const { eval_count: count, eval_duration: ns } = speed.figures;
  const tokensPerSecond = count && ns ? Math.round((count / (ns / 1e9)) * 10) / 10 : 0;
  step();

  const checks: MeasureCheck[] = [];
  for (const c of CASES) {
    let ok: boolean;
    if (c.kind === "tools") {
      const system = withTools("Use the provided tools when they help; answer directly when they do not.", CHECK_TOOLS);
      const { reply } = await ask([{ role: "system", content: system }, { role: "user", content: c.prompt }], CHECK_TOKENS, CHECK_TOOLS);
      ok = c.pass(reply);
    } else {
      const system = withTools(`You answer questions about a shop's SQLite database by calling the sql tool once with one SELECT query. Schema:\n${SCHEMA}`, SQL_TOOLS);
      const { reply } = await ask([{ role: "system", content: system }, { role: "user", content: c.prompt }], CHECK_TOKENS, SQL_TOOLS);
      const query = only(reply, "sql")?.query;
      ok = false;
      if (typeof query === "string") {
        const rows = await runSnapshotQuery({ file: input.dbFile, query, limit: 20, signal: input.signal, timeoutMs: QUERY_MS }).catch(() => []);
        const first = rows[0];
        ok = typeof first === "object" && first !== null && Object.values(first).some((cell) => isAnswer(cell, c.answer));
      }
    }
    checks.push({ id: c.id, kind: c.kind, ok });
    step();
  }
  const passed = checks.filter((c) => c.ok).length;
  return { at: (input.now ?? Date.now)(), numCtx: MEASURE_CTX, tokensPerSecond, score: Math.round((100 * passed) / checks.length), checks };
}
