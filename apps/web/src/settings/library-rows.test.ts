import type { SampleDatabase, Source, SourceImport } from "@gates-local/contracts";
import { describe, expect, it } from "vitest";
import { askWhy, databaseRows } from "./library-rows.ts";

const sample = (id: string): SampleDatabase => ({ id, label: id, description: `${id} data`, sizeBytes: 1000, url: `https://example.test/${id}.db`, license: "MIT", licenseUrl: "https://example.test/LICENSE", tables: [{ name: "t", rows: 1 }], questions: ["q1", "q2", "q3", "q4"] });
const SAMPLES = [sample("chinook"), sample("northwind"), sample("worldcup")];
const db = (id: string, addedAt: number, managed?: string): Source => ({ id, kind: "sqlite", label: id, path: `/data/${id}.db`, addedAt, state: "ready", ...(managed ? { managed: { kind: "sample", key: managed } } : {}) });
const job = (key: string, state: SourceImport["state"], sourceId?: string): SourceImport => ({ id: `job-${key}`, key, label: key, kind: "sample", state, bytes: 10, total: 1000, ...(sourceId ? { sourceId } : {}) });
const STATES: SourceImport["state"][] = ["downloading", "adding", "ready", "error", "cancelled"];

describe("the Databases rows", () => {
  it("samples in catalog order, then own databases in the order added", () => {
    const rows = databaseRows(SAMPLES, [db("mine-2", 20), db("worldcup-copy", 5, "worldcup"), db("mine-1", 10)], []);
    expect(rows.map(r => r.key)).toEqual(["sample:chinook", "sample:northwind", "sample:worldcup", "db:mine-1", "db:mine-2"]);
    expect(rows[2]?.source?.id).toBe("worldcup-copy");
    expect(rows[2]?.sample?.id).toBe("worldcup");
    expect(rows[3]?.sample).toBeUndefined();
  });

  it("leaves folders, files and repositories to their own groups", () => {
    const folder: Source = { id: "f", kind: "folder", label: "docs", path: "/docs", addedAt: 1, state: "ready" };
    const repo: Source = { ...folder, id: "r", managed: { kind: "repository", key: "https://github.com/a/b" } };
    expect(databaseRows(SAMPLES, [folder, repo], []).map(r => r.key)).toEqual(["sample:chinook", "sample:northwind", "sample:worldcup"]);
  });

  // The bug this list fixes: a downloaded sample showed twice, a screen apart.
  it.each(STATES.flatMap(state => [[state, true], [state, false]] as const))("one database, one row: job %s, in the Library %s", (state, inLibrary) => {
    const sources = inLibrary ? [db("copy", 1, "northwind"), db("mine", 2)] : [db("mine", 2)];
    const rows = databaseRows(SAMPLES, sources, [job("northwind", state, inLibrary ? "copy" : undefined), job("chinook", "error")]);
    expect(rows.map(r => r.key)).toEqual(["sample:chinook", "sample:northwind", "sample:worldcup", "db:mine"]);
    const ids = rows.flatMap(r => r.source ? [r.source.id] : []);
    expect(new Set(ids).size).toBe(ids.length);
    expect(rows.filter(r => r.sample?.id === "northwind" || r.source?.managed?.key === "northwind")).toHaveLength(1);
    const northwind = rows[1]!;
    // In the Library: the database's row, with no job left over; not yet: the sample with its job.
    expect(northwind.source?.id).toBe(inLibrary ? "copy" : undefined);
    expect(northwind.job?.state).toBe(inLibrary ? undefined : state);
    expect(rows[0]?.job?.state).toBe("error");
  });

  it("keeps the last job for a sample, so a Retry's own state is the one shown", () => {
    const rows = databaseRows(SAMPLES, [], [job("chinook", "error"), { ...job("chinook", "downloading"), id: "retry" }]);
    expect(rows[0]?.job?.id).toBe("retry");
  });

  it("a sample copy no longer in the catalog is still listed once, as a database of its own", () => {
    expect(databaseRows(SAMPLES, [db("old", 1, "retired")], []).map(r => r.key)).toEqual(["sample:chinook", "sample:northwind", "sample:worldcup", "db:old"]);
  });
});

describe("why a question cannot be asked", () => {
  const ready = { downloaded: true, chat: true, tools: true, tool: true };
  it("names the first thing missing, or nothing when it can be asked", () => {
    expect(askWhy(ready)).toBeNull();
    expect(askWhy({ ...ready, downloaded: false, chat: false })).toBe("Download it to ask these.");
    expect(askWhy({ ...ready, chat: false, tools: false })).toBe("Needs a model that can chat.");
    expect(askWhy({ ...ready, tools: false, tool: false })).toBe("Needs tools turned on, in Tools.");
    expect(askWhy({ ...ready, tool: false })).toBe("Needs the database tool, in Tools.");
  });
});
