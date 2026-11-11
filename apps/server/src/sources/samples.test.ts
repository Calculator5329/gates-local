import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { SAMPLES } from "./samples.ts";

interface Question { readonly kind: string; readonly text: string; readonly sql: string; readonly answer: string; readonly note?: string }
/** All five questions per sample with their SQL and answers, for a later model check (scripts/check-sample.ts runs them on a file). */
const FIXTURE = JSON.parse(readFileSync(new URL("./sample-questions.json", import.meta.url), "utf8")) as Record<string, readonly Question[]>;
const SHOWN = ["lookup", "ranking", "over-time", "join-3"];
/** A file at a full commit on GitHub's raw host, which answers it without a redirect (the downloader refuses one). */
const PINNED = /^https:\/\/raw\.githubusercontent\.com\/([\w.-]+)\/([\w.-]+)\/([0-9a-f]{40})\/[^?#]+\.(?:db|sqlite)$/;
/** The holder named in a licence line, "MIT · Copyright 2015 Lukasz Mentel" → "Lukasz Mentel". */
const holder = (license: string) => license.replace(/^.*(?:Copyright|©)\s+[\d–-]+\s+/, "");

describe("the sample catalog", () => {
  it("offers the four researched samples in a fixed order", () => {
    expect(SAMPLES.map(s => s.id)).toEqual(["chinook", "northwind", "worldcup", "elements"]);
    expect(Object.keys(FIXTURE).toSorted()).toEqual(SAMPLES.map(s => s.id).toSorted());
  });

  // The public record of what is downloaded and under which licence follows the catalog.
  it.each(SAMPLES.map(s => [s.id, s] as const))("%s: third-party notices and the README name it, its licence and its pinned commit", (_id, sample) => {
    const notices = readFileSync(new URL("../../../../THIRD_PARTY_NOTICES.md", import.meta.url), "utf8");
    const readme = readFileSync(new URL("../../../../README.md", import.meta.url), "utf8");
    const [, owner, repo, commit] = PINNED.exec(sample.url)!;
    expect(notices).toContain(sample.label);
    expect(notices).toContain(sample.license.split(" · ")[0]);
    expect(notices).toContain(holder(sample.license));
    expect(notices).toContain(`${owner}/${repo}/blob/${commit}`);
    expect(readme).toContain(`${sample.label} (`);
    expect(readme).toContain(`github.com/${owner}/${repo}`);
  });

  it.each(SAMPLES.map(s => [s.id, s] as const))("%s: four shown questions, one trap kept as test data", (id, sample) => {
    const all = FIXTURE[id]!;
    expect(all.map(q => q.kind)).toEqual([...SHOWN, "trap"]);
    for (const q of all) { expect(q.sql).toMatch(/^SELECT /); expect(q.answer.split("\n").length).toBeGreaterThan(1); }
    expect(sample.questions).toEqual(SHOWN.map(kind => all.find(q => q.kind === kind)!.text));
    expect(sample.questions).not.toContain(all.find(q => q.kind === "trap")!.text);
  });

  it.each(SAMPLES.map(s => [s.id, s] as const))("%s: its tables, a digest and a pinned no-redirect URL", (_id, sample) => {
    expect(sample.tables.length).toBeGreaterThan(0);
    expect(sample.tables.reduce((n, t) => n + t.rows, 0)).toBeGreaterThan(0);
    for (const t of sample.tables) expect(t.name).not.toBe("");
    expect(new Set(sample.tables.map(t => t.name)).size).toBe(sample.tables.length);
    expect(sample.sha256).toMatch(/^[0-9a-f]{64}$/);
    const pin = PINNED.exec(sample.url);
    expect(pin, sample.url).not.toBeNull();
    const [, owner, repo, commit] = pin!;
    expect(sample.licenseUrl.startsWith(`https://github.com/${owner}/${repo}/blob/${commit}/`)).toBe(true);
    expect(sample.sizeBytes).toBeGreaterThan(0);
  });

  it.each(SAMPLES.map(s => [s.id, s] as const))("%s: its own licence text, naming only its own holder", (_id, sample) => {
    const name = holder(sample.license);
    expect(name).not.toBe(sample.license);
    expect(sample.notice).toContain(name);
    expect(sample.notice).toContain(sample.licenseUrl);
    const [, owner, repo] = PINNED.exec(sample.url)!;
    expect(sample.notice).toContain(`https://github.com/${owner}/${repo}`);
    for (const other of SAMPLES) if (other !== sample) expect(sample.notice).not.toContain(holder(other.license));
    if (sample.license.startsWith("MIT")) expect(sample.notice).toContain("The MIT License");
    else expect(sample.notice).not.toContain("MIT");
  });

  it("World Cup is CC BY-SA 4.0 and its notice says so with the licence's own link", () => {
    const worldcup = SAMPLES.find(s => s.id === "worldcup")!;
    expect(worldcup.license).toBe("CC BY-SA 4.0 · © 2023 Joshua C. Fjelstul, Ph.D.");
    expect(worldcup.notice).toContain("Creative Commons Attribution-ShareAlike 4.0");
    expect(worldcup.notice).toContain("https://creativecommons.org/licenses/by-sa/4.0/");
  });
});
