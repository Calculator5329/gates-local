import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { checkBeforePush, checkTag, parseReport } from "./release.ts";

try {
  const { values, positionals } = parseArgs({ allowPositionals: true, options: { report: { type: "string" }, push: { type: "boolean", default: false } } });
  const version = positionals[0];
  if (!version || positionals.length !== 1 || !values.report) throw new Error("Usage: pnpm release:tag vX.Y.Z --report <file> [--push]");
  const input: unknown = JSON.parse(readFileSync(values.report, "utf8"));
  const report = parseReport(input);
  const plan = await checkTag(process.cwd(), version, report);
  if (values.push) {
    // Prepare the annotated object without creating a tag ref. Its identity
    // is known before publication, so cleanup can compare-and-delete safely.
    const tagger = execFileSync("git", ["var", "GIT_COMMITTER_IDENT"], { encoding: "utf8" }).trim();
    const object = execFileSync("git", ["mktag"], { input: `object ${plan.commit}\ntype commit\ntag ${version}\ntagger ${tagger}\n\n${plan.message}\n`, encoding: "utf8" }).trim();
    const ref = `refs/tags/${version}`;
    checkBeforePush(process.cwd(), version, plan.commit, report.remote);
    let created = false;
    try {
      execFileSync("git", ["update-ref", ref, object, "0".repeat(object.length)], { stdio: "inherit" });
      created = true;
      execFileSync("git", ["-c", "push.followTags=false", "push", "--no-follow-tags", "origin", `${object}:${ref}`], { stdio: "inherit" });
    } catch (error) {
      if (created) {
        // An unchanged immutable tag object also proves its target commit is unchanged.
        try { execFileSync("git", ["update-ref", "-d", ref, object], { stdio: "inherit" }); }
        catch (cleanup) { throw new AggregateError([error, cleanup], "Publication failed; cleanup could not remove this command's tag (a replaced tag is left alone)", { cause: cleanup }); }
      }
      throw error;
    }
    console.log(`Created and pushed ${version} at ${plan.commit}`);
  } else console.log(`Would create annotated tag ${version} at ${plan.commit} and push only that tag with --push.\n\n${plan.message}`);
} catch (error) {
  console.error(`Release refused: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}
