import { mkdirSync, mkdtempSync, rmSync, type Mode, type OpenMode } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";

const steps = vi.hoisted(() => [] as string[]);
const name = vi.hoisted(() => (file: string) => file.replace(/^.*[\\/]/, "").replace(/\.\d+\.tmp$/, ".tmp"));
vi.mock("node:fs", async (original) => {
  const fs = await original<typeof import("node:fs")>();
  const names = new Map<number, string>();
  return {
    ...fs,
    openSync: ((file: string, flags: OpenMode, mode?: Mode | null) => { const fd = fs.openSync(file, flags, mode); names.set(fd, name(file)); return fd; }) as typeof fs.openSync,
    fsyncSync: (fd: number) => { steps.push(`flush ${names.get(fd) ?? "?"}`); fs.fsyncSync(fd); },
    renameSync: (from: string, to: string) => { steps.push(`rename ${name(from)} ${name(to)}`); fs.renameSync(from, to); },
  };
});
const { writeAck } = await import("./ack.ts");

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

it("AK-04 the ack is flushed, then renamed, then its folder flushed before writeAck returns", () => {
  const root = mkdtempSync(path.join(tmpdir(), "iu-ack-flush-"));
  roots.push(root);
  mkdirSync(path.join(root, "updates"));
  steps.length = 0;
  writeAck(root, "T1");
  expect(steps).toEqual(["flush update-startup.json.tmp", "rename update-startup.json.tmp update-startup.json", "flush updates"]);
});
