import path from "node:path";
import type { RuleTester } from "oxlint/plugins-dev";

/** oxlint exports its rule and syntax-tree types only through the tester's signature. */
export type Rule = Parameters<RuleTester["run"]>[1];
export type Context = Parameters<NonNullable<Rule["create"]>>[0];
type Visitor = ReturnType<NonNullable<Rule["create"]>>;
type NodeOf<Kind extends keyof Visitor> = Parameters<NonNullable<Visitor[Kind]>>[0];
type ModuleName = NodeOf<"ImportDeclaration">["source"];

/** The file being linted, from the folder oxlint runs in, with forward slashes on every platform. */
export function repoPath(context: Context, file: string = context.filename): string {
  return path.relative(context.cwd, file).split(path.sep).join("/");
}

/** `apps/web`, `packages/contracts`: the workspace package a repo path sits in, if any. */
export function packageOf(file: string): string | undefined {
  return /^(?:apps|packages)\/[^/]+(?=\/)/.exec(file)?.[0];
}

/** Where a relative import lands, as a repo path. Undefined for a bare package name. */
export function landsIn(context: Context, specifier: string): string | undefined {
  if (!specifier.startsWith(".")) return undefined;
  return repoPath(context, path.resolve(path.dirname(context.filename), specifier));
}

/** Every place a file names another module: import, re-export, `import()` and `import("…")` types. */
export function eachImport(report: (node: ModuleName, specifier: string) => void): Visitor {
  return {
    ImportDeclaration: node => report(node.source, node.source.value),
    ExportNamedDeclaration: node => { if (node.source !== null) report(node.source, node.source.value); },
    ExportAllDeclaration: node => report(node.source, node.source.value),
    ImportExpression: ({ source }) => { if (source.type === "Literal" && typeof source.value === "string") report(source, source.value); },
    TSImportType: node => report(node.source, node.source.value),
  };
}

type Call = { on?: string; name: string };

/**
 * What a call names: `{ name: "useEffect" }` for `useEffect(…)`, and
 * `{ on: "React", name: "useEffect" }` for `React.useEffect(…)`. `on` is
 * "" when the receiver is anything but a plain name.
 */
function called(callee: NodeOf<"CallExpression">["callee"]): Call | undefined {
  if (callee.type === "Identifier") return { name: callee.name };
  if (callee.type !== "MemberExpression" || callee.computed || callee.property.type !== "Identifier") return undefined;
  return { on: callee.object.type === "Identifier" ? callee.object.name : "", name: callee.property.name };
}

/** A rule that reports each matching call; the calls that stay carry a reasoned disable above them. */
export function callRule(description: string, matches: (call: Call) => boolean, message: string): Rule {
  return {
    meta: { type: "suggestion", docs: { description } },
    create(context) {
      return {
        CallExpression(node) {
          const call = called(node.callee);
          if (call !== undefined && matches(call)) context.report({ node, message });
        },
      };
    },
  };
}
