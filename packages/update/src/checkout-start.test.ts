// What a start of a source checkout decides from the checkout's lock and
// saved update (checkout-start.ts), and the updater run a start asks for:
// one that finishes or takes back what a crash left and looks for nothing
// new. Real git repositories in a temporary folder, a fake pnpm.
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BUILD_DESKTOP_ARGS, BUILD_WEB_ARGS, INSTALL_ARGS, runUpdate, type UpdateOptions } from "./apply.ts";
import { DID_NOT_START, checkoutStartFacts, decideCheckoutStart, type CheckoutStartFacts } from "./checkout-start.ts";
import { runCli, type Relaunch } from "./cli.ts";
import { acquireLock } from "./lock.ts";
import { STARTUP_TOKEN_ENV, acknowledgeStartup } from "./startup.ts";
import { type Repos, commit, crashAt, fakePnpm, head, makeRepos, publish, removeRepos, testEnv } from "./testing.ts";
import type { Runner } from "./run.ts";
import { readLeft, readTransaction, saveLeft, saveTransaction, type Transaction } from "./transaction.ts";

let r: Repos;
beforeEach(() => {
  r = makeRepos();
  for (const [k, v] of Object.entries(testEnv(r.base))) vi.stubEnv(k, v);
});
afterEach(() => {
  vi.unstubAllEnvs();
  removeRepos(r);
});

const move = { channel: "main", branch: "main", from: { commit: "a".repeat(40), label: "aaaaaaa" }, to: { commit: "b".repeat(40), label: "bbbbbbb" }, changes: 1 } as const;
const forward: Transaction = { ...move, phase: "forward" };
const back: Transaction = { ...move, phase: "back", step: "install", reason: "pnpm failed" };
const launch = (startupToken?: string): Transaction => ({ ...move, phase: "launch", ...(startupToken === undefined ? {} : { startupToken }) });
const facts = (f: Partial<CheckoutStartFacts>): CheckoutStartFacts => ({ updating: false, transaction: null, token: undefined, tried: false, left: null, ...f });
const kind = (f: Partial<CheckoutStartFacts>) => decideCheckoutStart(facts(f)).kind;

describe("what a start decides", () => {
  it("starts when no update is running and none is saved", () => {
    expect(kind({})).toBe("start");
    // A mark left on the command line means nothing once the checkout is whole.
    expect(kind({ tried: true })).toBe("start");
  });

  it("waits while an updater holds the checkout, whatever it has saved so far", () => {
    for (const transaction of [null, forward, back, launch("t1"), launch()]) {
      expect(decideCheckoutStart(facts({ updating: true, transaction }))).toEqual({ kind: "wait", words: { text: "Gates Local is updating. It will reopen by itself." } });
    }
    expect(kind({ updating: true, transaction: forward, tried: true })).toBe("wait");
  });

  it("is the updater's own first start only with the token that update saved", () => {
    expect(kind({ updating: true, transaction: launch("t1"), token: "t1" })).toBe("start");
    expect(kind({ updating: true, transaction: launch("t1"), token: "t0" })).toBe("wait");
    expect(kind({ updating: true, transaction: launch("t1"), token: "" })).toBe("wait");
    // A token proves nothing before the build is done, or once the update has started back.
    expect(kind({ updating: true, transaction: forward, token: "t1" })).toBe("wait");
    expect(kind({ updating: true, transaction: back, token: "t1" })).toBe("wait");
    expect(kind({ updating: true, transaction: launch(), token: "" })).toBe("wait");
  });

  it("hands an update a crash left to the updater, once", () => {
    for (const transaction of [forward, back, launch("t1")]) {
      expect(decideCheckoutStart(facts({ transaction }))).toEqual({ kind: "finish", words: { text: "Gates Local is finishing an update." } });
      const after = decideCheckoutStart(facts({ transaction, tried: true }));
      expect(after.kind).toBe("say");
      expect(after.kind === "say" && after.lines[0]).toBe(DID_NOT_START);
      expect(after.kind === "say" && after.lines.join("\n")).toContain("The last update, to bbbbbbb, did not finish");
    }
    // The updater that saved the token has ended, so this is not its first start even with the token.
    expect(kind({ transaction: forward, token: "t1" })).toBe("finish");
  });

  it("is the new version's first start when it was built with nobody to start it", () => {
    expect(kind({ transaction: launch() })).toBe("start");
    expect(kind({ transaction: launch(), tried: true })).toBe("start");
  });
});

describe("what a start reads", () => {
  it("nothing in a folder that is no checkout, so it starts", () => {
    expect(decideCheckoutStart(checkoutStartFacts(r.data, { env: {}, tried: false })).kind).toBe("start");
  });

  it("a live updater's lock, and not one whose owner has ended", () => {
    expect(acquireLock(r.clone, { pid: process.pid }).ok).toBe(true);
    expect(checkoutStartFacts(r.clone, { env: {}, tried: false }).updating).toBe(true);
    expect(checkoutStartFacts(r.clone, { env: {}, tried: false }, { alive: () => false }).updating).toBe(false);
  });

  it("the saved update and this launch's token", () => {
    saveTransaction(r.clone, launch("t1"));
    expect(checkoutStartFacts(r.clone, { env: { [STARTUP_TOKEN_ENV]: "t1" }, tried: true })).toEqual({ updating: false, transaction: { ...launch("t1") }, token: "t1", tried: true, left: null });
  });
});

const isInstall = (command: string, args: readonly string[]) => command === "fake-pnpm" && args.join(" ") === INSTALL_ARGS.join(" ");
const isMerge = (command: string, args: readonly string[]) => command === "git" && args[0] === "merge";
const words = (fake: ReturnType<typeof fakePnpm>) => fake.calls.map((c) => c.args.join(" "));
const whole = [INSTALL_ARGS, BUILD_WEB_ARGS, BUILD_DESKTOP_ARGS].map((a) => a.join(" "));

function options(fake: ReturnType<typeof fakePnpm>, more: Partial<UpdateOptions> = {}): UpdateOptions {
  return {
    root: r.clone, runner: fake.runner, choice: "main", pnpm: fake.pnpm, appRunning: () => null, checkOnly: false, say: () => undefined, log: () => undefined,
    startApp: async ({ token }) => {
      acknowledgeStartup(r.clone, r.data, token);
      return { code: 0, stdout: "", stderr: "" };
    },
    ...more,
  };
}
const finish = (fake = fakePnpm(), more: Partial<UpdateOptions> = {}) => runUpdate(options(fake, { finishOnly: true, ...more }));

/** A newer version is published and the update to it is cut off at the first command `when` matches. */
async function cutOff(when: (command: string, args: readonly string[]) => boolean): Promise<{ old: string; target: string }> {
  const old = head(r.clone);
  const target = commit(r.seed, "Newer");
  publish(r.seed);
  await expect(runUpdate(options(crashAt(fakePnpm(), when)))).rejects.toThrow("the power went out");
  return { old, target };
}

describe("the run a start asks for", () => {
  it("with nothing saved it changes nothing and does not look for a newer version", async () => {
    const old = head(r.clone);
    commit(r.seed, "Newer");
    publish(r.seed);
    const fake = fakePnpm();
    expect(await finish(fake)).toEqual({ outcome: "settled" });
    expect(head(r.clone)).toBe(old);
    expect(fake.commands).toEqual([]);
  });

  it("finishes an update cut off after the switch, and stops at that version though a newer one is out", async () => {
    const { target } = await cutOff(isInstall);
    commit(r.seed, "Newer still");
    publish(r.seed);
    const fake = fakePnpm();
    expect(await finish(fake)).toMatchObject({ outcome: "updated", to: { commit: target } });
    expect(head(r.clone)).toBe(target);
    expect(words(fake)).toEqual(["--version", ...whole]);
    expect(fake.commands.filter((c) => c.startsWith("git fetch") || c.startsWith("git merge"))).toEqual([]);
    expect(readTransaction(r.clone)).toBeNull();
  });

  it("takes back an update whose install fails again, and is settled", async () => {
    const { old } = await cutOff(isInstall);
    const fake = fakePnpm((_args, n) => n === 2);
    expect(await finish(fake)).toMatchObject({ outcome: "stopped", step: "install" });
    expect(head(r.clone)).toBe(old);
    expect(readTransaction(r.clone)).toBeNull();
    expect(await finish()).toEqual({ outcome: "settled" });
  });

  it("clears an update cut off before anything moved", async () => {
    const { old } = await cutOff(isMerge);
    const fake = fakePnpm();
    expect(await finish(fake)).toEqual({ outcome: "settled" });
    expect(head(r.clone)).toBe(old);
    expect(words(fake)).toEqual(["--version"]);
    expect(readTransaction(r.clone)).toBeNull();
  });

  it("goes on over the person's own edit to a tracked file, and keeps the edit", async () => {
    const { target } = await cutOff(isInstall);
    writeFileSync(path.join(r.clone, "app.txt"), "my own note\n");
    // Asked for by hand, the update stops for the edit; a start goes on, since the install and builds leave it alone.
    expect(await runUpdate(options(fakePnpm()))).toMatchObject({ outcome: "refused", refusal: { reason: "local-changes" } });
    const fake = fakePnpm();
    expect(await finish(fake)).toMatchObject({ outcome: "updated" });
    expect(head(r.clone)).toBe(target);
    expect(words(fake)).toEqual(["--version", ...whole]);
    expect(readFileSync(path.join(r.clone, "app.txt"), "utf8")).toBe("my own note\n");
  });

  it("leaves the edit and the saved update when the install fails over it, and never resets", async () => {
    const { target } = await cutOff(isInstall);
    writeFileSync(path.join(r.clone, "app.txt"), "my own note\n");
    const fake = fakePnpm((_args, n) => n === 2);
    expect(await finish(fake)).toMatchObject({ outcome: "refused", refusal: { reason: "changed-during-update" } });
    expect(head(r.clone)).toBe(target);
    expect(fake.commands.filter((c) => c.startsWith("git reset"))).toEqual([]);
    expect(readFileSync(path.join(r.clone, "app.txt"), "utf8")).toBe("my own note\n");
    expect(readTransaction(r.clone)).not.toBeNull();
  });

  it("refuses while the app is open, before it reads anything else", async () => {
    await cutOff(isInstall);
    const fake = fakePnpm();
    expect(await finish(fake, { appRunning: () => ({ pid: 4242, file: "desktop.pid.json" }) })).toMatchObject({ outcome: "refused", refusal: { reason: "app-running" } });
    expect(fake.commands).toEqual([]);
    expect(readTransaction(r.clone)).not.toBeNull();
  });
});

async function cli(argv: string[], fake = fakePnpm()) {
  const lines: string[] = [];
  const relaunch = vi.fn((spec: Relaunch) => {
    spec.onStart?.(process.pid);
    if (spec.startup) acknowledgeStartup(r.clone, r.data, spec.startup.token);
    return { pid: process.pid, stop: async () => true };
  });
  const code = await runCli({ root: r.clone, argv: ["--data-dir", r.data, ...argv], defaultDataDir: r.data, pnpm: fake.pnpm, runner: fake.runner, appRunning: () => null, relaunch, print: (line) => lines.push(line), now: () => 1_762_500_000_000, platform: "linux" });
  return { code, text: lines.join("\n"), relaunch, fake };
}

describe("the command a start runs", () => {
  it("--finish with nothing saved changes nothing, and opens the app only when told to restart it", async () => {
    commit(r.seed, "Newer");
    publish(r.seed);
    const stays = await cli(["--finish"]);
    expect(stays.code).toBe(0);
    expect(stays.text).toContain("No update is left unfinished");
    expect(stays.fake.commands).toEqual([]);
    expect(stays.relaunch).not.toHaveBeenCalled();
    const quit = await cli(["--finish", "--restart", "--relaunch-arg=."]);
    expect(quit.code).toBe(0);
    expect(quit.relaunch).toHaveBeenCalledTimes(1);
    expect(quit.relaunch.mock.calls[0]![0].startup).toBeUndefined();
  });

  it("--finish finishes the cut-off update and starts the new version itself, once", async () => {
    const { target } = await cutOff(isInstall);
    const run = await cli(["--finish"]);
    expect(run.code).toBe(0);
    expect(head(r.clone)).toBe(target);
    expect(run.relaunch).toHaveBeenCalledTimes(1);
    expect(run.relaunch.mock.calls[0]![0].startup).toMatchObject({ commit: target });
    expect(readTransaction(r.clone)).toBeNull();
  });

  it("--finish that goes back leaves the opening to the start that ran it", async () => {
    const { old } = await cutOff(isInstall);
    // The install works; the new version then fails its first start, and the update goes back.
    const lines: string[] = [];
    const relaunch = vi.fn((spec: Relaunch) => {
      spec.onStart?.(process.pid);
      return { pid: process.pid, stop: async () => true };
    });
    const fake = fakePnpm();
    const code = await runCli({ root: r.clone, argv: ["--data-dir", r.data, "--finish"], defaultDataDir: r.data, pnpm: fake.pnpm, runner: fake.runner, appRunning: () => null, relaunch, alive: () => false, print: (line) => lines.push(line), now: () => 1_762_500_000_000, platform: "linux", startupTimeoutMs: 50 });
    expect(code).toBe(1);
    expect(head(r.clone)).toBe(old);
    expect(readTransaction(r.clone)).toBeNull();
    // One call: the new version's start. No second one to open the old version; the waiting start does that.
    expect(relaunch).toHaveBeenCalledTimes(1);
    expect(relaunch.mock.calls[0]![0].startup).toBeDefined();
  });

  it("a start on a copy cut off while git was writing files says that state and the way back, starts nothing and changes nothing, each time", async () => {
    // Some of the new version's files are written; the commit has not moved.
    const old = head(r.clone);
    const target = commit(r.seed, "Newer");
    publish(r.seed);
    const torn = fakePnpm();
    const runner: Runner = async (command, args, o) => {
      if (!isMerge(command, args)) return torn.runner(command, args, o);
      writeFileSync(path.join(r.clone, "app.txt"), "half of the new version\n");
      throw new Error("the power went out");
    };
    await expect(runUpdate(options({ ...torn, runner }))).rejects.toThrow("the power went out");
    const label = readTransaction(r.clone)!.to.label;
    for (const _ of [1, 2]) {
      // The person starts the app: it looks, and asks the updater to finish.
      expect(decideCheckoutStart(checkoutStartFacts(r.clone, { env: {}, tried: false })).kind).toBe("finish");
      const run = await cli(["--finish"]);
      expect(run.code).toBe(1);
      expect(run.relaunch).not.toHaveBeenCalled();
      // It asks which pnpm is there and runs no install and no build.
      expect(words(run.fake)).toEqual(["--version"]);
      expect(run.fake.commands.filter((c) => /^git (reset|merge|checkout|clean|stash)\b/.test(c))).toEqual([]);
      // The same start looks again and says what the updater found, in its words.
      expect(decideCheckoutStart(checkoutStartFacts(r.clone, { env: {}, tried: true }))).toEqual({
        kind: "say",
        lines: [
          "Gates Local did not start.",
          `The last update, to ${label}, was cut off while it was changing files, so this copy is part way between two versions.`,
          "These tracked files differ from the commit this copy is on:",
          "  app.txt",
          "The updater will not clean this up itself, because any edits of your own would be among those files. Copy those somewhere safe first.",
          "To get back: run `git reset --hard` (it discards uncommitted edits to tracked files), then `pnpm run app-update`.",
          "Or by hand: close Gates Local, then git reset --hard, git pull, pnpm install, pnpm start.",
        ],
      });
      expect(head(r.clone)).toBe(old);
      expect(readFileSync(path.join(r.clone, "app.txt"), "utf8")).toBe("half of the new version\n");
      expect(readTransaction(r.clone)).toMatchObject({ phase: "forward", to: { commit: target } });
    }
  });

  it("what a finishing run said about one update is not shown for another, or once the copy is whole", async () => {
    const { target } = await cutOff(isInstall);
    saveLeft(r.clone, { to: "c".repeat(40), lines: ["Words about some other update."] });
    const other = decideCheckoutStart(checkoutStartFacts(r.clone, { env: {}, tried: true }));
    expect(other.kind === "say" && other.lines.join("\n")).not.toContain("some other update");
    expect(other.kind === "say" && other.lines.join("\n")).toContain("did not finish");
    saveLeft(r.clone, { to: target, lines: ["Words about this update."] });
    expect(decideCheckoutStart(checkoutStartFacts(r.clone, { env: {}, tried: true }))).toEqual({ kind: "say", lines: [DID_NOT_START, "Words about this update."] });
    // The run that finishes it removes the words with the saved update.
    expect((await cli(["--finish"])).code).toBe(0);
    expect(readLeft(r.clone)).toBeNull();
    expect(decideCheckoutStart(checkoutStartFacts(r.clone, { env: {}, tried: true })).kind).toBe("start");
  });

  it("--finish takes no target and no check", async () => {
    expect((await cli(["--finish", "--check"])).code).toBe(2);
    expect((await cli(["--finish", "--target-commit", "a".repeat(40)])).code).toBe(2);
  });
});
