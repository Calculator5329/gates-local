// What the stylesheet may contain: the two radii, the one error red, the
// sheets' safe-area padding, and no rules for a dock that nothing renders.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const css = readFileSync(new URL("./styles.css", import.meta.url), "utf8");

/** Every value a declaration gives `prop`, across the sheet. */
const values = (prop: string, sheet = css) => [...sheet.matchAll(new RegExp(`(?:^|[;{\\s])${prop}:([^;}]+)`, "g"))].map((m) => (m[1] ?? "").trim());

/** Each theme's value for a GPU-bar grey, as a number. */
const hex = (name: string) => [...css.matchAll(new RegExp(`--seg-${name}:#([0-9a-f]{6})`, "g"))].map((m) => parseInt(m[1] ?? "0", 16));

describe("styles.css", () => {
  it("rounds with two radii: 6 px controls and 10 px containers (a circle stays a circle; pills, switches and Settings' tighter scale are their own)", () => {
    const tokens = [...css.replace(/\.set,\.snav\{[^}]*\}/, "").matchAll(/--r-[a-z]+:([^;]+);/g)].map((m) => (m[1] ?? "").trim());
    expect(tokens.length).toBeGreaterThan(0);
    expect(new Set(tokens)).toEqual(new Set(["10px", "6px"]));
    const allowed = /^(0|50%|var\(--r-[a-z]+\))$/;
    const odd = values("border-radius", css.replace(/\.(pill|switch)\{[^}]*\}/g, "")).flatMap((v) => v.split(/\s+/)).filter((v) => !allowed.test(v));
    expect(odd).toEqual([]);
  });

  it("has one error red, the same in both themes", () => {
    const fg = [...css.matchAll(/--red-fg:([^;]+);/g)].map((m) => (m[1] ?? "").trim());
    const red = [...css.matchAll(/--red:([^;]+);/g)].map((m) => (m[1] ?? "").trim());
    expect(fg.length).toBeGreaterThan(1);
    expect(new Set([...fg, ...red]).size).toBe(1);
  });

  it("orders the GPU bar's two greys the same way in both themes", () => {
    const whisper = hex("whisper");
    const occupant = hex("occupant");
    expect(whisper.length).toBeGreaterThan(1);
    whisper.forEach((w, i) => expect(w).toBeLessThan(occupant[i] ?? 0));
  });

  it("keeps a menu sheet's bottom padding above the safe area", () => {
    const rule = /\.pop\.menu\{([^}]*)\}/.exec(css.slice(css.indexOf("@media (max-width:640px)")));
    expect(rule?.[1]).toContain("env(safe-area-inset-bottom)");
  });

  it("carries no rules for the approval dock nothing renders", () => {
    expect(css).not.toMatch(/\.dock\b|\.dk-[a-z]|\.diff\b/);
  });
});
