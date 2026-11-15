import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { packageOf, repoPath, type Context, type Rule } from "./rule.ts";

type Options = { external: string[] };
type Comment = ReturnType<Context["sourceCode"]["getAllComments"]>[number];
type Statement = Context["sourceCode"]["ast"]["body"][number];
/** One `/* *\/` comment, or a run of `//` lines with nothing between them. */
type Block = { start: number; end: number; loc: Comment["loc"]; jsdoc: boolean; oneLine: boolean; text: string };

const WHY_MOST_CHARACTERS = 100;

const MESSAGE = "A comment in product source is one of six kinds: "
  + "a licence or origin header that opens the file; "
  + "a directive with its reason (`oxlint-disable-next-line <rule> -- <why>`, `@ts-expect-error <why>`); "
  + "`external:` and the outside thing that forces this code (Ollama, a browser, Windows); "
  + "`decision:` and a row of docs/decisions.md or a heading of docs/design.md, in quotes; "
  + "JSDoc on an exported declaration that a package offers to others; "
  + `\`why:\` and a reason of our own, as one \`//\` line of at most ${WHY_MOST_CHARACTERS} characters directly above the code. `
  + "Anything else is said by something that is checked. "
  + "If it restates the code or tells its history, delete it: history is in the commit and the changelog. "
  + "If it says what a declaration is or returns, delete it and make the name say so. "
  + "If it states a rule (never, must, only, always), write the check, then delete it: "
  + "a type that cannot hold the wrong value, a test, a lint rule or an assertion. "
  + "If the reason is forced from outside, start it `external:` and keep the one fact. "
  + "If the reason is our own and a short, ordinary name cannot carry it, write the one `why:` line; never a sentence in a name. "
  + "If it points at another file, the import or the name already does.";

const WHY_SHAPE = `\`why:\` is one \`//\` line of at most ${WHY_MOST_CHARACTERS} characters, slashes included, on its own line, `
  + "with the code it explains on the next line. This one is a block, a run of lines, too long, behind code, "
  + "or has no code under it. Cut it to the one reason. If it will not fit, the reason is a rule (write the check) "
  + "or an outside fact (`external:`), or the code wants a plainer shape.";

const NO_REASON = "A directive says why it is here: end a disable with `-- <reason>`, and follow `@ts-expect-error` with the reason.";

const unnamed = (known: string[]) =>
  "`external:` names the outside thing that forces this code, and this comment names none the rule knows "
  + `(${known.join(", ")}). Name it. A new one that this repo truly cannot reshape joins the rule's \`external\` list in `
  + "lint/rules.oxlintrc.json in the same commit. A reason of our own is not `external:`: let a name or a type say it.";

const noRow = (doc: string, title: string | undefined) =>
  "`decision:` is followed by `docs/decisions.md \"<row title>\"` or `docs/design.md \"<heading>\"`, and the row or heading exists. "
  + (title === undefined ? "This one names neither." : `${doc} has no "${title}".`)
  + " A row is not written to keep a comment: without one, the code says the reason or the comment goes.";

const LICENCE = /\b(?:MIT|ISC|BSD|Apache|Copyright|SPDX-License-Identifier)\b/;
const DISABLE = /^(?:oxlint|eslint)-disable(?:-next-line|-line)?(?![\w-])([\s\S]*)$/;
const ENABLE = /^(?:oxlint|eslint)-enable(?![\w-])/;
const EXPECT_ERROR = /^@ts-expect-error(?![\w-])([\s\S]*)$/;
const DIRECTIVE = /^(?:(?:oxlint|eslint)-|@ts-)/;
/** Tool pragmas that are not prose: a triple-slash reference, and Vite's mark on a dynamic import. */
const PRAGMAS = [/^\/\s*<reference\s[^>]*\/>$/, /^@vite-ignore$/];
const DECISION = /^(docs\/(?:decisions|design)\.md)\s+"([^"]+)"/;

/** A comment's words, without the stars a block comment starts its lines with. */
function words(comment: Comment): string {
  if (comment.type === "Line") return comment.value.trim();
  return comment.value.split("\n").map(line => line.replace(/^\s*\*+\s?/, "").trim()).join("\n").trim();
}

const ownLine = (source: string, comment: Comment) =>
  source.slice(source.lastIndexOf("\n", comment.start - 1) + 1, comment.start).trim() === "";

function blocks(comments: Comment[], source: string): Block[] {
  const runs: Comment[][] = [];
  for (const comment of comments) {
    if (comment.type === "Shebang") continue;
    const run = runs.at(-1);
    const last = run?.at(-1);
    const joins = run !== undefined && last !== undefined && run[0] !== undefined
      && comment.type === "Line" && last.type === "Line"
      && !DIRECTIVE.test(words(comment)) && !DIRECTIVE.test(words(last))
      && ownLine(source, run[0])
      && /^[ \t]*\r?\n[ \t]*$/.test(source.slice(last.end, comment.start));
    if (joins) run.push(comment);
    else runs.push([comment]);
  }
  return runs.flatMap((run) => {
    const first = run[0], last = run.at(-1);
    if (first === undefined || last === undefined) return [];
    return [{
      start: first.start,
      end: last.end,
      loc: first.loc,
      jsdoc: first.type === "Block" && first.value.startsWith("*"),
      oneLine: run.length === 1 && first.type === "Line",
      text: run.map(words).join("\n").trim(),
    }];
  });
}

/** Whether the line under a comment is code: not blank, not another comment, not only the end of a block. */
function codeIsOnTheNextLine(source: string, block: Block): boolean {
  const lineEnd = source.indexOf("\n", block.end);
  if (lineEnd === -1 || source.slice(block.end, lineEnd).trim() !== "") return false;
  const nextEnd = source.indexOf("\n", lineEnd + 1);
  const next = source.slice(lineEnd + 1, nextEnd === -1 ? source.length : nextEnd).trim();
  return next !== "" && !/^(?:\/\/|\/\*|\{\s*\/\*|[\])}])/.test(next);
}

const escaped = (text: string) => text.replaceAll(/[.*+?^${}()|[\]\\/-]/g, String.raw`\$&`);

/** Whether the text names one of the listed things as a word of its own, in any case, plural or possessive. */
function names(text: string, things: string[]): boolean {
  return things.some(thing => new RegExp(String.raw`(?<![\w])${escaped(thing)}(?:'s|s)?(?![\w])`, "i").test(text));
}

const headings = new Map<string, Set<string>>();

/** Every heading of a Markdown file; a dated row (`2026-01-02 · Title`) also answers to its title alone. */
function headingsOf(file: string): Set<string> {
  const known = headings.get(file);
  if (known !== undefined) return known;
  const found = new Set<string>();
  if (existsSync(file)) {
    for (const line of readFileSync(file, "utf8").split("\n")) {
      const heading = /^#{1,6}\s+(.+?)\s*$/.exec(line)?.[1];
      if (heading === undefined) continue;
      found.add(heading);
      const title = /^\d{4}-\d{2}-\d{2}\s+·\s+(.+)$/.exec(heading)?.[1];
      if (title !== undefined) found.add(title);
    }
  }
  headings.set(file, found);
  return found;
}

/** What a file offers to other packages: every export, or only the names an entry re-exports. */
type Surface = "all" | Set<string>;
type Offered = { patterns: RegExp[]; files: Map<string, Surface> };

const offered = new Map<string, Offered>();
const REEXPORT = /^\s*export\s+(?:type\s+)?(\*(?:\s+as\s+\w+)?|\{[^}]*\})\s+from\s+["'](\.{1,2}\/[^"']+)["']/gm;

function targets(exports: unknown): string[] {
  if (typeof exports === "string") return [exports];
  if (typeof exports !== "object" || exports === null) return [];
  return Object.values(exports).flatMap(targets);
}

/**
 * The files a package's `exports` reach: each target, each file a target
 * re-exports whole (`export * from`), and, for `export { a } from`, the
 * named declarations only.
 */
function offeredBy(packageDir: string): Offered {
  const known = offered.get(packageDir);
  if (known !== undefined) return known;
  const result: Offered = { patterns: [], files: new Map() };
  offered.set(packageDir, result);
  const manifest = path.join(packageDir, "package.json");
  if (!existsSync(manifest)) return result;
  const queue: string[] = [];
  for (const target of targets((JSON.parse(readFileSync(manifest, "utf8")) as { exports?: unknown }).exports)) {
    const file = path.join(packageDir, target);
    if (target.includes("*")) result.patterns.push(new RegExp(`^${file.split("*").map(escaped).join(".*")}$`));
    else if (!result.files.has(file)) { result.files.set(file, "all"); queue.push(file); }
  }
  for (let file = queue.shift(); file !== undefined; file = queue.shift()) {
    if (!existsSync(file)) continue;
    for (const [, what = "", from = ""] of readFileSync(file, "utf8").matchAll(REEXPORT)) {
      const target = path.resolve(path.dirname(file), from);
      const before = result.files.get(target);
      if (before === "all") continue;
      if (what.startsWith("*")) { result.files.set(target, "all"); queue.push(target); continue; }
      const named = before ?? new Set<string>();
      for (const part of what.slice(1, -1).split(",")) {
        const name = /^\s*(?:type\s+)?([\w$]+)/.exec(part)?.[1];
        if (name !== undefined) named.add(name);
      }
      result.files.set(target, named);
    }
  }
  return result;
}

function surfaceOf(packageDir: string, file: string): Surface | undefined {
  const { patterns, files } = offeredBy(packageDir);
  return patterns.some(pattern => pattern.test(file)) ? "all" : files.get(file);
}

/** The names an `export` statement declares; none for `export { a }` and `export * from`. */
function declared(statement: Statement): string[] {
  if (statement.type === "ExportDefaultDeclaration") return ["default"];
  if (statement.type !== "ExportNamedDeclaration" || statement.declaration === null) return [];
  const { declaration } = statement;
  if (declaration.type === "VariableDeclaration") {
    return declaration.declarations.flatMap(each => each.id.type === "Identifier" ? [each.id.name] : []);
  }
  return "id" in declaration && declaration.id !== null && declaration.id.type === "Identifier" ? [declaration.id.name] : [];
}

const rule: Rule = {
  meta: {
    type: "suggestion",
    docs: { description: "A comment in product source is one of six mechanical kinds; anything else is said by the code or a check." },
    schema: [{
      type: "object",
      properties: { external: { type: "array", items: { type: "string" } } },
      required: ["external"],
      additionalProperties: false,
    }],
  },
  create(context) {
    const { external } = context.options[0] as Options;
    return {
      Program(program) {
        const source = context.sourceCode.text;
        const home = packageOf(repoPath(context));
        const surface = home?.startsWith("packages/") ? surfaceOf(path.join(context.cwd, home), context.filename) : undefined;
        const documented = (block: Block) => block.jsdoc && surface !== undefined && program.body.some(statement =>
          statement.start >= block.end
          && source.slice(block.end, statement.start).trim() === ""
          && declared(statement).some(name => surface === "all" || surface.has(name)));

        const refusal = (block: Block): string | undefined => {
          const { text } = block;
          const disabled = DISABLE.exec(text)?.[1];
          if (disabled !== undefined) return /\s--\s+\S/.test(disabled) ? undefined : NO_REASON;
          const expected = EXPECT_ERROR.exec(text)?.[1];
          if (expected !== undefined) return /\w/.test(expected) ? undefined : NO_REASON;
          if (ENABLE.test(text) || PRAGMAS.some(pragma => pragma.test(text))) return undefined;
          if (source.slice(0, block.start).trim() === "" && LICENCE.test(text)) return undefined;
          const forced = /^external:\s*([\s\S]*)$/.exec(text)?.[1];
          if (forced !== undefined) return names(forced, external) ? undefined : unnamed(external);
          const decided = /^decision:\s*([\s\S]*)$/.exec(text)?.[1];
          if (decided !== undefined) {
            const [, doc = "", title] = DECISION.exec(decided) ?? [];
            return title !== undefined && headingsOf(path.join(context.cwd, doc)).has(title) ? undefined : noRow(doc, title);
          }
          if (text.startsWith("why:")) {
            const shaped = block.oneLine && /^why:\s+\S/.test(text)
              && block.end - block.start <= WHY_MOST_CHARACTERS
              && source.slice(source.lastIndexOf("\n", block.start - 1) + 1, block.start).trim() === ""
              && codeIsOnTheNextLine(source, block);
            return shaped ? undefined : WHY_SHAPE;
          }
          return documented(block) ? undefined : MESSAGE;
        };

        for (const block of blocks(context.sourceCode.getAllComments(), source)) {
          const message = refusal(block);
          if (message !== undefined) context.report({ loc: block.loc, message });
        }
      },
    };
  },
};

export default rule;
