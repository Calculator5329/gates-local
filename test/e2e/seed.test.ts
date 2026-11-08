// The screenshot seeds write the same timestamps whatever the host's time
// zone: the sidebar times are wall-clock times in the shots' fixed zone
// (America/Chicago, the browser timezoneId in shots.spec.ts and
// readme-shots.spec.ts), never in the zone of the process that seeds.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { openThreadStore } from "../../apps/server/src/threads/store.ts";
import { seedDesign, seedReadme } from "./seed.ts";

/** Thu 2026-11-12 14:00 in Chicago, as in the shot specs. */
const NOW = Date.UTC(2026, 10, 12, 20, 0);
const shown = new Intl.DateTimeFormat("en-US", { timeZone: "America/Chicago", weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });

/** Seeds a fresh store with the host zone set to `tz`; returns each thread's title and Chicago time. */
function seededTimes(seed: (db: string, now: number) => string, tz: string): string[] {
  const before = process.env["TZ"];
  process.env["TZ"] = tz;
  const dir = mkdtempSync(path.join(tmpdir(), "seed-tz-"));
  try {
    // Proves the zone really changed for this process; otherwise the test is hollow.
    expect(new Date(NOW).getTimezoneOffset()).toBe(tz === "UTC" ? 0 : 360);
    const db = path.join(dir, "threads.sqlite");
    seed(db, NOW);
    const store = openThreadStore(db);
    try {
      return store.listThreads().map((t) => `${t.title} @ ${shown.format(t.createdAt)} / ${shown.format(t.updatedAt)}`);
    } finally {
      store.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
    if (before === undefined) delete process.env["TZ"];
    else process.env["TZ"] = before;
  }
}

describe("screenshot seeds", () => {
  it.each([["readme", seedReadme], ["design", seedDesign]] as const)("%s writes the same times under UTC and Chicago hosts", (_name, seed) => {
    const utc = seededTimes(seed, "UTC");
    const chicago = seededTimes(seed, "America/Chicago");
    expect(utc).toEqual(chicago);
  });

  it("readme puts its older threads at Chicago wall-clock times", () => {
    const times = seededTimes(seedReadme, "UTC");
    expect(times).toContain("Summarize the CAP theorem @ Wed, Oct 21, 11:00 AM / Wed, Oct 21, 11:00 AM");
    expect(times).toContain("What is a B-tree? @ Wed, Nov 11, 4:12 PM / Wed, Nov 11, 4:12 PM");
  });
});
