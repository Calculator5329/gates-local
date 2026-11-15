// `docs/feature-map.md` from the map in `feature-map.ts`. `pnpm feature-map`
// writes it; `feature-map.test.ts` fails when the committed page differs.
import { FEATURES, GROUPS, SHARED_WINDOW, type Feature, type Group } from "./feature-map.ts";

export const PAGE = "docs/feature-map.md";

const cell = (s: string): string => s.replaceAll("|", "\\|");

const anchor = (g: Group): string => g.toLowerCase().replace(/[^a-z0-9 -]/g, "").replaceAll(" ", "-");

/** `test/e2e/x.spec.ts` as `x`, other specs by their path from the root without the suffix. */
const specName = (s: string): string => s.replace(/\.spec\.ts$/, "");

function code(f: Feature): string {
  const parts: string[] = [];
  if (f.window.length > 0) parts.push(`web: ${f.window.map((p) => `\`${p}\``).join(", ")}`);
  if (f.server.length > 0) parts.push(`server: ${f.server.map((p) => `\`${p}\``).join(", ")}`);
  if (f.desktop !== undefined) parts.push(`desktop: ${f.desktop.map((p) => `\`${p}\``).join(", ")}`);
  if (f.packages !== undefined) parts.push(`packages: ${f.packages.map((p) => `\`${p}\``).join(", ")}`);
  return parts.join("<br>");
}

function row(f: Feature): string {
  const aka = f.aka === undefined ? "" : `<br>also: ${f.aka.join(", ")}`;
  const tests = f.specs.length === 0 ? "none" : f.specs.map((s) => `\`${specName(s)}\``).join(", ");
  return `| **${cell(f.name)}**${cell(aka)} | ${cell(f.what)} ${cell(f.where)} | ${cell(code(f))} | ${tests} |`;
}

export function render(): string {
  const out = [
    "# Feature map",
    "",
    "Every feature by the name the screen gives it, where it is, the code behind",
    "it and the browser specs that drive it. Generated from `test/feature-map.ts`",
    "by `pnpm feature-map`; edit that file, not this page. The wire calls and test",
    "ids of each feature are in the data file.",
    "",
    "Web paths are under `apps/web/src/`, server paths under `apps/server/src/`,",
    "desktop paths under `apps/desktop/src/`. A spec is in `test/e2e/` unless it",
    "has a path.",
    "",
    GROUPS.map((g) => `[${g}](#${anchor(g)})`).join(" · "),
    "",
  ];
  for (const g of GROUPS) {
    const rows = FEATURES.filter((f) => f.group === g);
    if (rows.length === 0) continue;
    out.push(`## ${g}`, "", "| Feature | What it is, and where | Code | Tests |", "| --- | --- | --- | --- |", ...rows.map(row), "");
  }
  out.push("## Shared", "", "Window folders every feature uses:", "");
  for (const [folder, why] of SHARED_WINDOW) out.push(`- \`${folder}\`: ${why}.`);
  out.push("");
  return out.join("\n");
}
