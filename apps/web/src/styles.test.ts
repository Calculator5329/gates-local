// What the stylesheet may contain: the two radii, the one error red, the
// sheets' safe-area padding.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const css = ["styles.css", "picker.css"].map(file => readFileSync(new URL(file, import.meta.url), "utf8")).join("\n");

/** Every value a declaration gives `prop`, across the sheet. */
const values = (prop: string, sheet = css) => [...sheet.matchAll(new RegExp(`(?:^|[;{\\s])${prop}:([^;}]+)`, "g"))].map((m) => (m[1] ?? "").trim());

/** Each theme's value for a GPU-bar grey, as a number. */
const hex = (name: string) => [...css.matchAll(new RegExp(`--seg-${name}:#([0-9a-f]{6})`, "g"))].map((m) => parseInt(m[1] ?? "0", 16));

/** A custom property's value inside one rule's body. */
const token = (block: string, name: string) => new RegExp(`--${name}:([^;]+);`).exec(block)?.[1]?.trim();

/** WCAG relative luminance of a #rrggbb colour. */
function luminance(colour: string): number {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(colour.slice(i, i + 2), 16) / 255).map((c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * (r ?? 0) + 0.7152 * (g ?? 0) + 0.0722 * (b ?? 0);
}

/** WCAG contrast ratio between two #rrggbb colours. */
function ratio(a: string, b: string): number {
  const [lo, hi] = [luminance(a), luminance(b)].toSorted((x, y) => x - y);
  return ((hi ?? 0) + 0.05) / ((lo ?? 0) + 0.05);
}

describe("styles.css", () => {
  it("keeps Dictate a square icon button: nothing gives it its own width or a visible label", () => {
    expect(css).not.toMatch(/\.voice\s*\{[^}]*(?:^|[;{\s])(?:width|flex(?:-basis)?):\s*[^;}]*\d+px/m);
    expect(css).not.toMatch(/\.voice span[,{\s]/);
  });
  it("PK-05: declares reachable 44 px phone controls without hover-only favorite actions", () => {
    const phone = css.slice(css.indexOf("@media(max-width:640px){\n.pk-layout"));
    const rule = (selector: string) => [...phone.matchAll(/([^{}]+)\{([^{}]+)\}/g)].find(m => m[1]?.trim().split(",").includes(selector))?.[2] ?? "";
    for (const selector of [".model-picker .pk-fam", ".pk-favorite", ".pk-back"]) {
      expect(rule(selector), selector).toMatch(/(?:^|;)width:44px(?:;|$)/);
      expect(rule(selector), selector).toMatch(/(?:^|;)height:44px(?:;|$)/);
    }
    expect(rule(".pk-favorite")).toContain("opacity:1");
    expect(rule(".pk-bottom button")).toContain("height:44px");
  });
  it("keeps the approved 4 px picker details, 6 px controls and existing 10 px containers (circles, pills, switches and Settings have their own scale)", () => {
    const tokens = [...css.replace(/\.set,\.snav\{[^}]*\}/, "").matchAll(/--r-[a-z]+:([^;]+);/g)].map((m) => (m[1] ?? "").trim());
    expect(tokens.length).toBeGreaterThan(0);
    expect(new Set(tokens)).toEqual(new Set(["10px", "6px", "4px"]));
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

  it("Accent: Neutral is the theme foreground, and every colour clears 3:1 on the background with --on-accent readable on it, in each theme", () => {
    const sheet = readFileSync(new URL("styles.css", import.meta.url), "utf8");
    const blocks = {
      light: /^:root\{([^}]*)\}/m.exec(sheet)?.[1] ?? "",
      "dark (system)": /:root:not\(\[data-theme="light"\]\)\{([^}]*)\}/.exec(sheet)?.[1] ?? "",
      "dark (picked)": /:root\[data-theme="dark"\]\{([^}]*)\}/.exec(sheet)?.[1] ?? "",
    };
    expect(token(blocks.light, "accent")).toBe("var(--foreground)");
    /** A token as the theme sees it: its own value, else the light root's, with var(--x) followed inside the theme. */
    const resolve = (block: string, name: string): string => {
      const value = token(block, name) ?? token(blocks.light, name) ?? "";
      const ref = /^var\(--([a-z-]+)\)$/.exec(value)?.[1];
      return ref === undefined ? value : resolve(block, ref);
    };
    for (const name of ["green", "blue", "violet", "amber", "red"]) {
      expect(sheet).toContain(`:root[data-accent="${name}"]{--accent:var(--accent-${name})}`);
      for (const [theme, block] of Object.entries(blocks)) {
        const bg = resolve(block, "background");
        const onAccent = resolve(block, "on-accent");
        const colour = resolve(block, `accent-${name}`);
        expect([bg, onAccent, colour], `${theme} tokens for ${name}`).toEqual([expect.stringMatching(/^#[0-9a-f]{6}$/), expect.stringMatching(/^#[0-9a-f]{6}$/), expect.stringMatching(/^#[0-9a-f]{6}$/)]);
        expect(ratio(colour, bg), `${name} on the ${theme} background`).toBeGreaterThanOrEqual(3);
        expect(ratio(onAccent, colour), `--on-accent on ${name} in ${theme}`).toBeGreaterThanOrEqual(4.5);
      }
    }
  });

  it("keeps a menu sheet's bottom padding above the safe area", () => {
    const rule = /\.pop\.menu\{([^}]*)\}/.exec(css.slice(css.indexOf("@media (max-width:640px)")));
    expect(rule?.[1]).toContain("env(safe-area-inset-bottom)");
  });

});
