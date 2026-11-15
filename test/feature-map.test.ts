// Keeps test/feature-map.ts true. A new browser spec, window or server folder,
// or wire call that no feature names fails here, and so does a name in the
// map that no longer exists. The fix is an entry in test/feature-map.ts, then
// `pnpm feature-map` for the page.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { methods, pushes } from "@gates-local/contracts";
import { describe, expect, it } from "vitest";
import { FEATURES, GROUPS, SHARED_WINDOW } from "./feature-map.ts";
import { PAGE, render } from "./feature-map-page.ts";

const ROOT = path.join(import.meta.dirname, "..");
const WEB = "apps/web/src";
const SERVER = "apps/server/src";
const MAP = "test/feature-map.ts";

const specPath = (s: string): string => (s.includes("/") ? s : `test/e2e/${s}`);

/** Every folder below `root`, as a path relative to it. */
function folders(root: string, rel = ""): string[] {
  const out: string[] = [];
  for (const e of readdirSync(path.join(ROOT, root, rel), { withFileTypes: true })) {
    if (!e.isDirectory()) continue;
    const sub = rel === "" ? e.name : `${rel}/${e.name}`;
    out.push(sub, ...folders(root, sub));
  }
  return out;
}

/** A folder is covered when a named path is it, lies inside it, or holds it. */
function uncovered(root: string, named: readonly string[]): string[] {
  return folders(root, "").filter((dir) => !named.some((p) => p === dir || p.startsWith(`${dir}/`) || dir.startsWith(`${p}/`)));
}

function sourceText(dir: string): string {
  const parts: string[] = [];
  const walk = (rel: string) => {
    for (const e of readdirSync(path.join(ROOT, rel), { withFileTypes: true })) {
      const p = `${rel}/${e.name}`;
      if (e.isDirectory()) walk(p);
      else if (/\.tsx?$/.test(e.name) && !/\.test\.tsx?$/.test(e.name)) parts.push(readFileSync(path.join(ROOT, p), "utf8"));
    }
  };
  walk(dir);
  return parts.join("\n");
}

describe("feature map", () => {
  it("names every browser spec", () => {
    const named = new Set(FEATURES.flatMap((f) => f.specs.map(specPath)));
    const missing = readdirSync(path.join(ROOT, "test/e2e"))
      .filter((f) => f.endsWith(".spec.ts"))
      .map((f) => `test/e2e/${f}`)
      .filter((f) => !named.has(f));
    expect(missing.map((f) => `${f} is in no feature: add it to the specs of the feature it drives in ${MAP}.`)).toEqual([]);
  });

  it("puts every window and server folder in a feature", () => {
    const web = [...FEATURES.flatMap((f) => f.window), ...SHARED_WINDOW.map(([folder]) => folder)];
    const server = FEATURES.flatMap((f) => f.server);
    const missing = [...uncovered(WEB, web).map((d) => `${WEB}/${d}`), ...uncovered(SERVER, server).map((d) => `${SERVER}/${d}`)];
    expect(missing.map((d) => `${d} is in no feature: add it, or a file in it, to a feature in ${MAP}.`)).toEqual([]);
  });

  it("puts every wire call and push in a feature", () => {
    const calls = new Set(FEATURES.flatMap((f) => f.calls));
    const chans = new Set(FEATURES.flatMap((f) => f.pushes));
    const missing = [
      ...Object.keys(methods).filter((m) => !calls.has(m)).map((m) => `method ${m} is in no feature: add it to calls in ${MAP}.`),
      ...Object.keys(pushes).filter((p) => !chans.has(p)).map((p) => `push ${p} is in no feature: add it to pushes in ${MAP}.`),
    ];
    expect(missing).toEqual([]);
  });

  it("names only paths, specs, calls and test ids that exist", () => {
    const web = sourceText(WEB);
    const has = (id: string): boolean =>
      id.endsWith("*") ? web.includes(`${id.slice(0, -1)}\${`) : new RegExp(`["'\`]${id.replaceAll(".", "\\.")}["'\`]`).test(web);
    const wrong: string[] = [];
    const exists = (p: string, f: string) => {
      if (!existsSync(path.join(ROOT, p))) wrong.push(`${f}: ${p} does not exist.`);
    };
    for (const f of FEATURES) {
      for (const p of f.window) exists(`${WEB}/${p}`, f.id);
      for (const p of f.server) exists(`${SERVER}/${p}`, f.id);
      for (const p of f.desktop ?? []) exists(`apps/desktop/src/${p}`, f.id);
      for (const p of f.packages ?? []) exists(`packages/${p}`, f.id);
      for (const s of f.specs) exists(specPath(s), f.id);
      for (const m of f.calls) if (!(m in methods)) wrong.push(`${f.id}: method ${m} is not in the protocol.`);
      for (const c of f.pushes) if (!(c in pushes)) wrong.push(`${f.id}: push ${c} is not in the protocol.`);
      for (const id of f.testIds ?? []) if (!has(id)) wrong.push(`${f.id}: test id ${id} is not in ${WEB}.`);
    }
    for (const [folder] of SHARED_WINDOW) {
      if (!existsSync(path.join(ROOT, WEB, folder)) || !statSync(path.join(ROOT, WEB, folder)).isDirectory()) wrong.push(`shared: ${WEB}/${folder} is not a folder.`);
    }
    const ids = FEATURES.map((f) => f.id);
    for (const dup of new Set(ids.filter((id, i) => ids.indexOf(id) !== i))) wrong.push(`${dup} is used by two features.`);
    for (const g of GROUPS) if (!FEATURES.some((f) => f.group === g)) wrong.push(`group ${g} has no feature.`);
    expect(wrong).toEqual([]);
  });

  it("matches the committed page", () => {
    const page = readFileSync(path.join(ROOT, PAGE), "utf8");
    expect(page === render(), `${PAGE} is out of date: run pnpm feature-map.`).toBe(true);
  });
});
