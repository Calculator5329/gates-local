// The bug packet: for every failed browser test, a packet/ folder in that
// test's output folder that a reader (often a model) can trace the cause from
// without rerunning anything:
//   packet.md    title and file:line, the error and its source lines, the last
//                steps, the page as text, console errors and failed requests,
//                the server's log for the test's seconds, and the verdicts
//   frames.png   about 12 frames, most in the last 4 s before the failure
//   video.webm   the whole test, when the run recorded video
//   packet.json  the same facts for scripts; paths relative to packet/
//   server.log   the server's lines during the test
// A green test writes nothing. The forwarder outside the repo picks the
// packets out of a run's results and adds the commit range.
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { stripVTControlCharacters } from "node:util";
import { chromium, type Browser } from "@playwright/test";
import type { FullConfig, Reporter, TestCase, TestError, TestResult, TestStep } from "@playwright/test/reporter";
import { ROOT } from "../env.ts";
import { writeSheet, type Span } from "./sheet.ts";
import { readTrace, type Note } from "./trace.ts";

const plain = (text: string | undefined) => stripVTControlCharacters(text ?? "");
/** Server lines kept in memory: about ten minutes of a busy stack. */
const SERVER_LINES = 20_000;

type Line = { readonly at: number; readonly text: string };
type Step = Span & { readonly depth: number; readonly failed: boolean; readonly category: string };

function flatten(steps: readonly TestStep[], depth = 0, out: Step[] = []): Step[] {
  for (const step of steps) {
    // After Hooks is teardown: it runs after the failure and only adds noise.
    if (step.category === "hook" && step.title === "After Hooks") continue;
    const start = step.startTime.getTime();
    if (["test.step", "pw:api", "expect"].includes(step.category)) {
      out.push({ start, end: start + step.duration, title: plain(step.title), depth, failed: step.error !== undefined, category: step.category });
    }
    flatten(step.steps, ["test.step", "pw:api", "expect"].includes(step.category) ? depth + 1 : depth, out);
  }
  return out;
}

/** The section of Playwright's error-context.md that holds the page's aria snapshot. */
function pageSnapshot(file: string | undefined): string {
  if (!file || !existsSync(file)) return "";
  const text = readFileSync(file, "utf8");
  const start = text.indexOf("# Page snapshot");
  if (start < 0) return "";
  const rest = text.slice(start + "# Page snapshot".length);
  const end = rest.search(/\n# /);
  return (end < 0 ? rest : rest.slice(0, end)).trim().replace(/^```yaml\n?|```$/g, "").trim();
}

function sourceLines(error: TestError): string {
  if (error.snippet) return plain(error.snippet);
  const where = error.location;
  if (!where || !existsSync(where.file)) return "";
  const lines = readFileSync(where.file, "utf8").split("\n");
  return lines.slice(Math.max(0, where.line - 4), where.line + 2)
    .map((line, i) => `${Math.max(1, where.line - 3) + i === where.line ? ">" : " "} ${String(Math.max(1, where.line - 3) + i).padStart(4)} | ${line}`).join("\n");
}

const clip = (text: string, lines: number) => {
  const all = text.split("\n");
  return all.length <= lines ? text : `${all.slice(0, lines).join("\n")}\n… ${all.length - lines} more lines`;
};
const fence = (text: string, lang = "text") => `\`\`\`${lang}\n${text.replaceAll("```", "ʼʼʼ")}\n\`\`\``;
const offset = (at: number, start: number) => `+${((at - start) / 1000).toFixed(1)}s`;

export default class PacketReporter implements Reporter {
  private server: Line[] = [];
  private queue: Promise<void> = Promise.resolve();
  private browser: Promise<Browser> | undefined;
  private config: FullConfig | undefined;

  onBegin(config: FullConfig): void {
    this.config = config;
  }

  // The stack's output reaches reporters as stderr with no test; its server lines are "[server] ...".
  onStdErr(chunk: string | Buffer, test?: TestCase): void {
    if (test) return;
    const at = Date.now();
    for (const text of chunk.toString().split("\n")) if (text.trim() !== "") this.server.push({ at, text: plain(text) });
    if (this.server.length > SERVER_LINES) this.server.splice(0, this.server.length - SERVER_LINES);
  }

  onTestEnd(test: TestCase, result: TestResult): void {
    if (result.status === "passed" || result.status === "skipped" || result.status === "interrupted" || result.status === test.expectedStatus) return;
    // One packet at a time: each opens a page in the shared sheet browser.
    this.queue = this.queue.then(() => this.write(test, result)).catch((error: unknown) => {
      console.error(`[packet] could not write the packet for ${test.title}: ${error instanceof Error ? error.message : String(error)}`);
    });
  }

  async onEnd(): Promise<void> {
    await this.queue;
    await (await this.browser?.catch(() => undefined))?.close();
  }

  private sheetBrowser(test: TestCase): Promise<Browser> {
    const use = test.parent.project()?.use ?? this.config?.projects[0]?.use;
    this.browser ??= chromium.launch({ ...use?.launchOptions, ...(use?.channel ? { channel: use.channel } : {}), headless: true });
    return this.browser;
  }

  private async write(test: TestCase, result: TestResult): Promise<void> {
    const file = (name: string) => result.attachments.find(a => a.name === name && a.path)?.path;
    const trace = file("trace");
    const video = result.attachments.find(a => a.contentType.startsWith("video/") && a.path)?.path;
    const screenshot = result.attachments.find(a => a.name === "screenshot" && a.path)?.path;
    const errorContext = file("error-context");
    const anyFile = trace ?? errorContext ?? screenshot ?? video;
    const outDir = anyFile ? path.dirname(anyFile) : path.join(test.parent.project()?.outputDir ?? ROOT, `packet-${test.id}`);
    const dir = path.join(outDir, "packet");
    mkdirSync(dir, { recursive: true });
    const rel = (target: string | undefined) => (target ? path.relative(dir, target).split(path.sep).join("/") : null);

    const startAt = result.startTime.getTime();
    const endAt = startAt + result.duration;
    const steps = flatten(result.steps);
    const failedStep = steps.findLast(step => step.failed);
    const failedAt = failedStep?.end ?? endAt;
    const error = result.errors[0] ?? result.error ?? {};
    const message = plain(error.message ?? error.value ?? `status ${result.status}`);
    const title = test.titlePath().filter(Boolean).slice(1).join(" › ");
    const where = `${path.relative(ROOT, test.location.file).split(path.sep).join("/")}:${test.location.line}`;

    let notes: readonly Note[] = [];
    let frames = 0;
    let framesWhy = "";
    if (trace && existsSync(trace)) {
      try {
        const parsed = readTrace(trace);
        notes = parsed.notes.filter(note => note.at >= startAt - 1000 && note.at <= endAt + 1000);
        frames = await writeSheet(await this.sheetBrowser(test), path.join(dir, "frames.png"), {
          title: `${title}  (${where})`, error: message.split("\n").filter(line => line.trim() !== "").slice(0, 5).join("\n"), frames: parsed.frames, startAt, failedAt, steps,
        });
        if (frames === 0) framesWhy = "the trace holds no screencast frames (the test failed before a page opened)";
      } catch (e) {
        framesWhy = `the trace could not be read: ${e instanceof Error ? e.message : String(e)}`;
      }
    } else {
      framesWhy = "the run kept no trace";
    }
    if (video && existsSync(video)) copyFileSync(video, path.join(dir, "video.webm"));
    const serverLines = this.server.filter(line => line.at >= startAt && line.at <= endAt + 500);
    writeFileSync(path.join(dir, "server.log"), serverLines.map(line => `${offset(line.at, startAt)} ${line.text}`).join("\n") + "\n");

    const json = {
      test: title,
      file: where.slice(0, where.lastIndexOf(":")),
      line: test.location.line,
      error: message,
      video: video && existsSync(video) ? "video.webm" : null,
      frames: frames > 0 ? "frames.png" : null,
      trace: rel(trace),
      serverLog: "server.log",
      screenshot: rel(screenshot),
      errorContext: rel(errorContext),
      project: test.parent.project()?.name ?? "",
      status: result.status,
      startedAt: new Date(startAt).toISOString(),
      failedAt: new Date(failedAt).toISOString(),
      durationMs: result.duration,
      errorLocation: error.location ? { file: path.relative(ROOT, error.location.file).split(path.sep).join("/"), line: error.location.line } : null,
      steps: steps.slice(-15).map(step => ({ at: step.start - startAt, ms: step.end - step.start, title: step.title, failed: step.failed })),
      notes: notes.map(note => ({ at: note.at - startAt, kind: note.kind, text: note.text })),
      secondRun: null,
    };
    writeFileSync(path.join(dir, "packet.json"), JSON.stringify(json, null, 2) + "\n");

    const lastSteps = steps.filter(step => step.start <= failedAt + 50).slice(-15);
    const snapshot = pageSnapshot(errorContext);
    const md = [
      `# ${title}`,
      "",
      `\`${where}\` · ${result.status} after ${(result.duration / 1000).toFixed(1)} s · failed at ${offset(failedAt, startAt)}`,
      "",
      "## Error",
      "",
      fence(clip(message, 40)),
      ...(error.location ? ["", `At \`${json.errorLocation?.file}:${error.location.line}\`:`, "", fence(sourceLines(error), "ts")] : []),
      "",
      "## What the test was doing",
      "",
      "Last steps, time from the test's start; ✗ is the step that failed.",
      "",
      fence(lastSteps.map(step => `${step.failed ? "✗" : " "} ${offset(step.start, startAt).padStart(7)} ${"  ".repeat(step.depth)}${step.title} (${Math.round(step.end - step.start)} ms)`).join("\n") || "(no steps recorded)"),
      "",
      "## Screen",
      "",
      frames > 0 ? `\`frames.png\`: ${frames} frames, most in the last 4 s; the red one is the moment of failure.` : `No frames.png: ${framesWhy}.`,
      json.video ? "`video.webm`: the whole test." : "No video: this run did not record one.",
      ...(json.screenshot ? [`\`${json.screenshot}\`: the full-size screen at the failure.`] : []),
      ...(json.trace ? [`Step through it: \`pnpm exec playwright show-trace ${json.trace}\`.`] : []),
      "",
      "## The page at the failure",
      "",
      snapshot ? fence(clip(snapshot, 120), "yaml") : "No page snapshot was written.",
      "",
      "## Browser console errors and failed requests",
      "",
      notes.length > 0 ? fence(notes.map(note => `${offset(note.at, startAt).padStart(7)} ${note.kind}: ${note.text}`).join("\n")) : "None during the test.",
      "",
      "## Server log during the test",
      "",
      serverLines.length > 0 ? fence(clip(serverLines.slice(-60).map(line => `${offset(line.at, startAt).padStart(7)} ${line.text}`).join("\n"), 60)) + (serverLines.length > 60 ? `\n\nAll ${serverLines.length} lines: \`server.log\`.` : "") : "The server wrote nothing during the test.",
      "",
      "## Second run",
      "",
      "Not run: retries stay 0, so this is the first and only attempt.",
      "",
      "## Verdict",
      "",
      "Reach one of these and record it on the packet's inbox line:",
      "",
      "- **fixed**: the app was wrong; name the commit that fixes it.",
      "- **the test was wrong**: the app is right; name the commit that fixes the test.",
      "- **dismissed**: neither needs a change; give the reason.",
      "",
    ].join("\n");
    writeFileSync(path.join(dir, "packet.md"), md);
    console.log(`[packet] ${path.relative(process.cwd(), dir) || dir}`);
  }
}
