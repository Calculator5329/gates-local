// The screenshot seeds write the same timestamps whatever the host's time
// zone: the sidebar times are wall-clock times in the shots' fixed zone
// (America/Chicago, the browser timezoneId in shots.spec.ts and
// readme-shots.spec.ts), never in the zone of the process that seeds.
// Each seed runs in a fresh Node process started in the zone under test, so
// a formatter that seed.ts builds at import time sees that zone too; setting
// process.env.TZ in this process would not reach one built before it.
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { openThreadStore } from "../../apps/server/src/threads/store.ts";

/** Thu 2026-11-12 14:00 in Chicago, as in the shot specs. */
const NOW = Date.UTC(2026, 10, 12, 20, 0);
const SEED = pathToFileURL(path.join(import.meta.dirname, "seed.ts")).href;
const shown = new Intl.DateTimeFormat("en-US", { timeZone: "America/Chicago", weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });

type Seed = "seedReadme" | "seedDesign";

/** Seeds a fresh store from a Node process whose zone is `tz` from its start; returns each thread's title and Chicago time. */
function seededTimes(seed: Seed, tz: string): string[] {
  const dir = mkdtempSync(path.join(tmpdir(), "seed-tz-"));
  try {
    const db = path.join(dir, "threads.sqlite");
    const script = `import { ${seed} } from ${JSON.stringify(SEED)}; ${seed}(process.argv[1], ${NOW}); console.log(new Date(${NOW}).getTimezoneOffset());`;
    const offset = execFileSync(process.execPath, ["--input-type=module", "-e", script, db], { env: { ...process.env, TZ: tz }, encoding: "utf8" });
    // Proves the child really ran in that zone; otherwise the test is hollow.
    expect(Number(offset.trim())).toBe(tz === "UTC" ? 0 : 360);
    const store = openThreadStore(db);
    try {
      return store.listThreads().map((t) => `${t.title} @ ${shown.format(t.createdAt)} / ${shown.format(t.updatedAt)}`);
    } finally {
      store.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("screenshot seeds", () => {
  it.each([["readme", "seedReadme"], ["design", "seedDesign"]] as const)("%s writes the same times under UTC and Chicago hosts", (_name, seed) => {
    const utc = seededTimes(seed, "UTC");
    const chicago = seededTimes(seed, "America/Chicago");
    expect(utc.length).toBeGreaterThan(0);
    expect(utc).toEqual(chicago);
  });

  it("readme puts its older threads at Chicago wall-clock times", () => {
    const times = seededTimes("seedReadme", "UTC");
    expect(times).toContain("Summarize the CAP theorem @ Wed, Oct 21, 11:00 AM / Wed, Oct 21, 11:00 AM");
    expect(times).toContain("What is a B-tree? @ Wed, Nov 11, 4:12 PM / Wed, Nov 11, 4:12 PM");
  });
});
