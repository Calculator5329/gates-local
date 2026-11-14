import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";

const here = path.dirname(fileURLToPath(import.meta.url));
const queries = [
  ["--query-gpu=memory.total,memory.used,memory.free", "--format=csv,noheader,nounits"],
  ["--query-gpu=name,memory.total,memory.used,memory.free", "--format=csv,noheader,nounits"],
  ["--query-compute-apps=pid,process_name,used_memory", "--format=csv,noheader,nounits"],
  ["--query-gpu=name"],
  ["--query-gpu=unknown"],
  [],
  ["--format=csv", "--query-gpu=name", "--query-gpu=unknown"],
  ["--query-gpu=unknown", "--query-gpu=name", "an argument with spaces"],
];
const mib = 1024 * 1024;
const states = [
  { name: "no state named" },
  { name: "missing file", missing: true },
  { name: "empty file", json: "" },
  { name: "invalid JSON", json: "{\"absent\":true," },
  { name: "trailing garbage", json: '{"otherMib":400}junk' },
  { name: "null", json: "null" },
  { name: "scalar", json: "123" },
  { name: "array", json: '[{"absent":true,"totalMib":1}]' },
  { name: "empty object", json: "{}" },
  { name: "idle", state: { loaded: [], otherMib: 0 } },
  { name: "other program", state: { loaded: [], otherMib: 1200 } },
  { name: "small card", state: { otherMib: 0, totalMib: 8192 } },
  { name: "overfull card", state: { loaded: [{ sizeBytes: 8_000 * mib }], otherMib: 1200, totalMib: 8192 } },
  { name: "one loaded model", state: { loaded: [{ name: "fixture:9b", sizeBytes: 6000 * mib, context: 4096 }], otherMib: 0 } },
  { name: "two loaded or filling models", state: { loaded: [{ sizeBytes: 3500 * mib }, { sizeBytes: 2400 * mib }], otherMib: 1500, totalMib: 24000 } },
  { name: "per-model rounding", state: { loaded: [{ sizeBytes: 1.5 * mib }, { sizeBytes: 1.499 * mib }, { sizeBytes: -0.5 * mib }] } },
  { name: "negative memory", state: { loaded: [{ sizeBytes: -2.5 * mib }], otherMib: -10, totalMib: -1 } },
  { name: "zero total", state: { totalMib: 0 } },
  { name: "fractional memory", state: { otherMib: 0.5, totalMib: 9000.25 } },
  { name: "non-numeric fields", state: { loaded: [{ sizeBytes: "99999" }, null, 4, { nested: { sizeBytes: 99999 } }], otherMib: "7", totalMib: null } },
  { name: "non-array loaded", state: { loaded: { sizeBytes: 100 * mib }, otherMib: 20, totalMib: 9000 } },
  { name: "nested and escaped metadata", state: { loaded: [{ name: 'quote " and \\ and } ] sizeBytes', nested: [{ sizeBytes: 9000 * mib }], sizeBytes: 42 * mib }], metadata: { absent: true, otherMib: 9999 } } },
  { name: "pretty JSON and exponents", json: '{\n "loaded": [{"sizeBytes": 1.048576e6}],\n "otherMib": 2e2, "totalMib": 1.6e4\n}' },
  { name: "escaped field names", json: '{"loade\\u0064":[{"sizeByte\\u0073":1048576}],"otherMi\\u0062":100}' },
  { name: "duplicate fields", json: '{"loaded":[{"sizeBytes":9999999,"sizeBytes":1048576}],"otherMib":200,"otherMib":0,"totalMib":3,"totalMib":16303}' },
  { name: "absent GPU", state: { absent: true, loaded: [{ sizeBytes: 6000 * mib }], otherMib: 4000 } },
  { name: "absent is strictly true", state: { absent: "true" } },
];

function run(script: string, args: string[], stateFile?: string) {
  const env = { ...process.env };
  delete env["GATES_LOCAL_FAKE_GPU_STATE"];
  if (stateFile !== undefined) env["GATES_LOCAL_FAKE_GPU_STATE"] = stateFile;
  const result = spawnSync(script.endsWith(".ts") ? process.execPath : script, script.endsWith(".ts") ? [script, ...args] : args, { env, encoding: "utf8", timeout: 5000 });
  if (result.error) throw result.error;
  expect(result.signal).toBeNull();
  return { stdout: result.stdout, stderr: result.stderr, status: result.status };
}

describe.skipIf(process.platform !== "linux")("Linux nvidia-smi parity with the Node reference", () => {
  const cache = process.env["TMPDIR"] ?? path.join(homedir(), ".cache", "gates-local-fake-gpu");
  mkdirSync(cache, { recursive: true });
  const scratch = mkdtempSync(path.join(cache, "smi-"));
  test.each(states)("$name (all query forms)", (row) => {
    const stateFile = "json" in row || "state" in row || "missing" in row ? path.join(scratch, `${row.name}.json`) : undefined;
    if (stateFile && row.json !== undefined) writeFileSync(stateFile, row.json);
    else if (stateFile && row.state !== undefined) writeFileSync(stateFile, JSON.stringify(row.state));
    for (const args of queries) {
      expect(run(path.join(here, "nvidia-smi.sh"), args, stateFile), args.join(" "))
        .toEqual(run(path.join(here, "nvidia-smi.ts"), args, stateFile));
    }
  });
  test("reads a direct writer's replacement at the same path", () => {
    const stateFile = path.join(scratch, "replaced.json");
    for (const state of [{ loaded: [] }, { loaded: [{ sizeBytes: 5000 * mib }], otherMib: 2000 }, { absent: true }, { loaded: [], totalMib: 8192 }]) {
      writeFileSync(stateFile, JSON.stringify(state));
      for (const args of queries) expect(run(path.join(here, "nvidia-smi.sh"), args, stateFile)).toEqual(run(path.join(here, "nvidia-smi.ts"), args, stateFile));
    }
  });
  test("the limited-arm launcher uses the same harness fixture after placement", () => {
    const cpus = /^Cpus_allowed_list:\s*(.+)$/m.exec(readFileSync("/proc/self/status", "utf8"))?.[1];
    if (!cpus) throw new Error("Cannot read this test's allowed CPUs");
    const result = spawnSync(path.join(here, "../perf/gpu-helper.sh"), queries[0], {
      env: { ...process.env, GATES_LOCAL_FAKE_GPU_STATE: "", GL_PERF_HELPER_GROUP: scratch, GL_PERF_HELPER_CPUS: cpus, GL_PERF_TARGET: path.join(scratch, "legacy-without-shell"), GL_PERF_NODE: "unused-node" },
      encoding: "utf8", timeout: 5000,
    });
    if (result.error) throw result.error;
    expect({ stdout: result.stdout, stderr: result.stderr, status: result.status }).toEqual(run(path.join(here, "nvidia-smi.ts"), queries[0]!));
    expect(readFileSync(path.join(scratch, "cgroup.procs"), "utf8")).toMatch(/^\d+$/);
  });
});
