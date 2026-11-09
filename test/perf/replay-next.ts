// Replays the new scorer over recorded runs. Takes result folders that hold
// round-N-base and round-N-candidate. Numbers only, no browser.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { DEFAULT_ALPHA, detectableChange, parseMetric, parseRun, scoreNext } from "./score-next.ts";
import { compare, type Run } from "./stats.ts";

const { values, positionals } = parseArgs({ allowPositionals: true, options: {
  rounds: { type: "string", default: "4" }, samples: { type: "string", default: "2" },
  trials: { type: "string", default: "300" }, alpha: { type: "string", default: String(DEFAULT_ALPHA) },
} });
const alpha = Number(values.alpha);

function loadRuns(folder: string): { base: Run[]; candidate: Run[] } | undefined {
  const names = readdirSync(folder).filter(name => /^round-\d+-(base|candidate)$/.test(name));
  const arm = (kind: "base" | "candidate") => names.filter(name => name.endsWith(kind)).toSorted((a, b) => Number(a.split("-")[1]) - Number(b.split("-")[1])).map(name => {
    const run = parseRun(readFileSync(path.join(folder, name, "run.json"), "utf8"));
    const firstRun = path.join(folder, name, "first-run.json");
    if (existsSync(firstRun)) run.metrics.push(parseMetric(readFileSync(firstRun, "utf8")));
    return run;
  });
  const base = arm("base"), candidate = arm("candidate");
  return base.length >= 4 && base.length === candidate.length ? { base, candidate } : undefined;
}

for (const folder of positionals) {
  const runs = loadRuns(folder);
  if (!runs) { console.log(`Skipped, incomplete: ${folder}`); continue; }
  const self = runs.base[0]!.commit === runs.candidate[0]!.commit;
  const verdicts = scoreNext(runs.base, runs.candidate, { alpha });
  const signals = verdicts.filter(v => v.signal !== "within noise");
  console.log(`\n# ${path.basename(path.dirname(folder))}/${path.basename(folder)} ${self ? "same build" : "different builds"}: ${verdicts.length} rows, ${signals.length} signals at alpha ${alpha}`);
  for (const v of signals) console.log(`  SIGNAL ${v.action} ${v.signal} delta ${v.delta.toFixed(2)} ${v.unit} (${v.percent?.toFixed(1) ?? "n/a"}%) p ${v.p.toFixed(4)} repetitions ${v.repetitions}`);
  if (!self) {
    const old = compare(runs.base, runs.candidate).filter(c => c.signal !== "within noise");
    console.log(`  current scorer signals: ${old.map(c => `${c.action} ${c.signal}`).join(", ") || "none"}`);
    continue;
  }
  const old = new Map(compare(runs.base, runs.candidate).map(c => [c.action, c]));
  const detectable = detectableChange(runs.base, runs.candidate, { rounds: Number(values.rounds), samples: Number(values.samples), trials: Number(values.trials), alpha });
  console.log(`| row | median | floor % | detectable % at ${values.rounds}x${values.samples} | false signals simulated | signal on recorded |`);
  console.log("| --- | ---: | ---: | ---: | ---: | --- |");
  for (const d of detectable) {
    const current = old.get(d.action)!;
    const floor = d.median === 0 ? "n/a" : (current.noiseFloor / d.median * 100).toFixed(0);
    console.log(`| ${d.action} | ${d.median.toFixed(1)} | ${floor} | ${d.percent === null ? "none" : d.percent.toFixed(1)} | ${(d.falseSignals * 100).toFixed(1)}% | ${verdicts.find(v => v.action === d.action)!.signal} |`);
  }
}
