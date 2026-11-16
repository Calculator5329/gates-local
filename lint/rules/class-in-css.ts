import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { packageOf, repoPath, type Context, type Rule } from "./rule.ts";

type Visitor = ReturnType<NonNullable<Rule["create"]>>;
type Attribute = Parameters<NonNullable<Visitor["JSXAttribute"]>>[0];
/** Any expression node; the walk reads only the few kinds that can hand a class name to className. */
type Node = { type: string; [key: string]: unknown };

const MESSAGE = (name: string) =>
  `No CSS rule in this package names the class \`${name}\`, and no test looks it up, so it styles nothing. `
  + "A class that styles nothing is a typo or a leftover: fix the name, add its rule to the package's CSS, or drop it.";

const SKIP = new Set(["node_modules", "dist", "out"]);

/** Every file under a folder whose name passes the test. */
function filesUnder(dir: string, wanted: (name: string) => boolean, out: string[] = []): string[] {
  let entries;
  try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const entry of entries) {
    const at = path.join(dir, entry.name);
    if (entry.isDirectory()) { if (!SKIP.has(entry.name)) filesUnder(at, wanted, out); }
    else if (wanted(entry.name)) out.push(at);
  }
  return out;
}

const SELECTOR_CLASS = /\.(-?[A-Za-z_][\w-]*)/g;
const QUOTED = /(["'`])((?:\\.|(?!\1)[^\\])*?)\1/g;
const CLASS_CHECK = /(?:toHaveClass|classList\.contains)\(\s*(?:\/(?:\\b)?|["'`])(-?[A-Za-z_][\w-]*)/g;

/**
 * Classes a test looks up: in a selector it quotes, by name in toHaveClass
 * and classList.contains, or as a word of a string on a line that reads a
 * className.
 */
function hooksIn(source: string, into: Set<string>) {
  for (const [, , quoted = ""] of source.matchAll(QUOTED)) for (const [, name] of quoted.matchAll(SELECTOR_CLASS)) if (name !== undefined) into.add(name);
  for (const [, name] of source.matchAll(CLASS_CHECK)) if (name !== undefined) into.add(name);
  for (const line of source.split("\n")) {
    if (!line.includes("className")) continue;
    for (const [, , quoted = ""] of line.matchAll(QUOTED)) for (const word of quoted.split(/\s+/)) if (/^-?[A-Za-z_][\w-]*$/.test(word)) into.add(word);
  }
}

const known = new Map<string, Set<string>>();

/**
 * The classes a package's components may name: each class a CSS file under
 * its src names in a selector, and each class its own tests or the repo's
 * browser tests look up.
 */
function classesOf(root: string, packageDir: string): Set<string> {
  const found = known.get(packageDir);
  if (found !== undefined) return found;
  const classes = new Set<string>();
  const src = path.join(root, packageDir, "src");
  for (const file of filesUnder(src, name => name.endsWith(".css"))) {
    const css = readFileSync(file, "utf8").replaceAll(/\/\*[\s\S]*?\*\//g, "");
    for (const [, name] of css.matchAll(/\.(-?[A-Za-z_][\w-]*)/g)) if (name !== undefined) classes.add(name);
  }
  const tests = [
    ...filesUnder(src, name => /\.test\.tsx?$/.test(name)),
    ...filesUnder(path.join(root, "test"), name => /\.(spec|test)\.tsx?$/.test(name)),
  ];
  for (const file of tests) hooksIn(readFileSync(file, "utf8"), classes);
  known.set(packageDir, classes);
  return classes;
}

type Piece = { node: Node; text: string; openStart: boolean; openEnd: boolean };

/**
 * The literal text a className value can end up holding: string literals and
 * template text in the places a value flows out of (both arms of a
 * condition, the right of `&&`, both sides of `||`, `??` and `+`, array
 * items, a `.join` of an array, the arguments of a class helper call).
 * A condition's test and a comparison's operands are not class names and
 * are not read. Template text that touches an expression is open at that
 * end: its first or last word may be only part of a class name.
 */
function pieces(node: Node | null | undefined, out: Piece[] = []): Piece[] {
  if (node === null || node === undefined) return out;
  switch (node.type) {
    case "Literal":
      if (typeof node["value"] === "string") out.push({ node, text: node["value"], openStart: false, openEnd: false });
      break;
    case "TemplateLiteral": {
      const quasis = node["quasis"] as Array<Node & { value: { cooked: string | null } }>;
      const texts = quasis.map(quasi => quasi.value.cooked ?? "");
      texts.forEach((text, at) => out.push({ node, text, openStart: at > 0, openEnd: at < texts.length - 1 }));
      (node["expressions"] as Node[]).forEach((expression, at) => {
        const inner = pieces(expression);
        const before = texts[at] ?? "", after = texts[at + 1] ?? "";
        for (const piece of inner) {
          if (before !== "" && !/\s$/.test(before)) piece.openStart = true;
          if (after !== "" && !/^\s/.test(after)) piece.openEnd = true;
        }
        out.push(...inner);
      });
      break;
    }
    case "ConditionalExpression":
      pieces(node["consequent"] as Node, out);
      pieces(node["alternate"] as Node, out);
      break;
    case "LogicalExpression":
      if (node["operator"] !== "&&") pieces(node["left"] as Node, out);
      pieces(node["right"] as Node, out);
      break;
    case "BinaryExpression":
      if (node["operator"] === "+") {
        const left = pieces(node["left"] as Node), right = pieces(node["right"] as Node);
        const lastLeft = left.at(-1), firstRight = right[0];
        if (lastLeft !== undefined) lastLeft.openEnd = true;
        if (firstRight !== undefined) firstRight.openStart = true;
        out.push(...left, ...right);
      }
      break;
    case "ArrayExpression":
      for (const item of node["elements"] as Array<Node | null>) pieces(item, out);
      break;
    case "CallExpression": {
      const callee = node["callee"] as Node;
      const property = callee.type === "MemberExpression" ? callee["property"] as Node : undefined;
      if (property?.type === "Identifier" && property["name"] === "join") pieces(callee["object"] as Node, out);
      else if (callee.type === "Identifier") for (const argument of node["arguments"] as Node[]) pieces(argument, out);
      break;
    }
    case "JSXExpressionContainer":
    case "ParenthesizedExpression":
    case "TSAsExpression":
    case "TSSatisfiesExpression":
      pieces(node["expression"] as Node, out);
      break;
  }
  return out;
}

/** The whole class names in one piece of text; a word at an open end is left out, being maybe only part of one. */
function namesIn({ text, openStart, openEnd }: Piece): string[] {
  const words = text.split(/\s+/);
  const whole = words.map((word, at) => (at === 0 && openStart) || (at === words.length - 1 && openEnd) ? "" : word);
  return whole.filter(word => word !== "");
}

export default {
  meta: { type: "problem", docs: { description: "Every class a component names in className has a rule in its package's CSS." } },
  create(context: Context) {
    const home = packageOf(repoPath(context));
    if (home === undefined) return {};
    const classes = classesOf(context.cwd, home);
    return {
      JSXAttribute(attribute: Attribute) {
        if (attribute.name.type !== "JSXIdentifier" || attribute.name.name !== "className") return;
        for (const piece of pieces(attribute.value as Node | null)) {
          for (const name of namesIn(piece)) {
            if (!classes.has(name)) context.report({ node: piece.node as never, message: MESSAGE(name) });
          }
        }
      },
    };
  },
} satisfies Rule;
