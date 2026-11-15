// The order of a source checkout's start (checkout-start.ts), with every act
// a recorded fake: what it does for each thing it can find in the checkout,
// and that the server's start is reached only when no update is in flight.
import { describe, expect, it } from "vitest";
import { DID_NOT_START, type CheckoutStart } from "@gates-local/update/checkout-start";
import { secondLaunch, updateStartup } from "@gates-local/update/installed/words";
import { LOOK_AGAIN_MS, startCheckout, type CheckoutStartActs, type Started } from "./checkout-start.ts";

const START: CheckoutStart = { kind: "start" };
const WAIT: CheckoutStart = { kind: "wait", words: secondLaunch() };
const FINISH: CheckoutStart = { kind: "finish", words: updateStartup() };
const SAY: CheckoutStart = { kind: "say", lines: [DID_NOT_START, "The last update, to v2, did not finish, so this copy may not run yet."] };

interface World {
  /** What each look finds, in order; the last one repeats. */
  readonly looks: CheckoutStart[];
  readonly claimed?: boolean;
  readonly finish?: Started;
  readonly handOver?: Started;
  /** What a look finds once the updater has run, whatever it found before. */
  readonly afterFinish?: CheckoutStart;
}

function world(w: World) {
  const did: string[] = [];
  let finished = false;
  const acts: CheckoutStartActs = {
    look: (tried) => {
      const found = finished && w.afterFinish !== undefined ? w.afterFinish : w.looks.length > 1 ? w.looks.shift()! : w.looks[0]!;
      // The decision itself (packages/update) turns a second finish into a say; this fake keeps that rule.
      const kind = found.kind === "finish" && tried ? SAY : found;
      did.push(`look${tried ? " (tried)" : ""}: ${kind.kind}`);
      return kind;
    },
    claim: () => {
      did.push("claim");
      return w.claimed ?? true;
    },
    unclaim: () => void did.push("unclaim"),
    start: () => void did.push("START"),
    pagesOnly: () => void did.push("pages only"),
    show: (words) => void did.push(`show: ${words.text}`),
    say: (lines) => void did.push(`say: ${lines.join(" | ")}`),
    finish: async () => {
      did.push("finish");
      finished = true;
      return w.finish ?? { ok: true };
    },
    handOver: async () => {
      did.push("hand over");
      return w.handOver ?? { ok: true };
    },
    again: () => void did.push("again"),
    sleep: async (ms) => void did.push(`sleep ${ms}`),
  };
  return { acts, did };
}

const run = async (w: World, o: { tried?: boolean; quitsToFinish?: boolean } = {}) => {
  const { acts, did } = world(w);
  const end = await startCheckout(acts, { tried: o.tried ?? false, quitsToFinish: o.quitsToFinish ?? false });
  return { end, did };
};

describe("a start with no update in flight", () => {
  it("looks, takes the app's lock, looks again and only then starts", async () => {
    expect(await run({ looks: [START] })).toEqual({ end: "started", did: ["look: start", "claim", "look: start", "START"] });
  });

  it("a second instance starts nothing", async () => {
    expect(await run({ looks: [START], claimed: false })).toEqual({ end: "second-instance", did: ["look: start", "claim"] });
  });

  it("an updater that began between the two looks is waited for, and the lock is given back", async () => {
    const { end, did } = await run({ looks: [START, WAIT, WAIT, START] });
    expect(end).toBe("started-again");
    expect(did).toEqual(["look: start", "claim", "look: wait", "unclaim", "pages only", `show: ${secondLaunch().text}`, `sleep ${LOOK_AGAIN_MS}`, "look: wait", `sleep ${LOOK_AGAIN_MS}`, "look: start", "again"]);
    expect(did).not.toContain("START");
  });
});

describe("a start while an updater runs", () => {
  it("says so once, looks again until it has ended, then starts the app as a new process", async () => {
    const { end, did } = await run({ looks: [WAIT, WAIT, WAIT, START] });
    expect(end).toBe("started-again");
    expect(did.filter((d) => d.startsWith("show"))).toEqual([`show: ${secondLaunch().text}`]);
    expect(did.at(-1)).toBe("again");
    expect(did).not.toContain("claim");
    expect(did).not.toContain("START");
  });

  it("an updater that died part way is followed by one finish attempt", async () => {
    const { end, did } = await run({ looks: [WAIT, FINISH], afterFinish: START });
    expect(end).toBe("started-again");
    expect(did).toEqual(["look: wait", "pages only", `show: ${secondLaunch().text}`, `sleep ${LOOK_AGAIN_MS}`, "look: finish", `show: ${updateStartup().text}`, "finish", "look (tried): start", "again"]);
  });
});

describe("a start that finds an update a crash left", () => {
  it("shows that it is finishing, runs the updater, and starts the app again once the checkout is whole", async () => {
    expect(await run({ looks: [FINISH], afterFinish: START })).toEqual({ end: "started-again", did: ["look: finish", "pages only", `show: ${updateStartup().text}`, "finish", "look (tried): start", "again"] });
  });

  it("says what is left when the updater leaves it unfinished, and does not try again", async () => {
    const { end, did } = await run({ looks: [FINISH] });
    expect(end).toBe("said");
    expect(did).toEqual(["look: finish", "pages only", `show: ${updateStartup().text}`, "finish", "look (tried): say", `say: ${SAY.kind === "say" ? SAY.lines.join(" | ") : ""}`]);
    expect(did.filter((d) => d === "finish")).toHaveLength(1);
  });

  it("waits for another updater that took over after its own", async () => {
    const { end, did } = await run({ looks: [FINISH, WAIT, START] });
    expect(end).toBe("started-again");
    expect(did.slice(3)).toEqual(["finish", "look (tried): wait", `show: ${secondLaunch().text}`, `sleep ${LOOK_AGAIN_MS}`, "look (tried): start", "again"]);
  });

  it("says why when the updater cannot be started, with where the checkout stands", async () => {
    const { end, did } = await run({ looks: [FINISH], finish: { ok: false, message: "The updater could not be started (ENOENT)." } });
    expect(end).toBe("said");
    expect(did.at(-1)).toBe(`say: ${DID_NOT_START} | The updater could not be started (ENOENT). | The last update, to v2, did not finish, so this copy may not run yet.`);
  });

  it("a start marked as following an attempt says what is left and runs nothing", async () => {
    expect(await run({ looks: [FINISH] }, { tried: true })).toEqual({ end: "said", did: ["look (tried): say", "pages only", `say: ${SAY.kind === "say" ? SAY.lines.join(" | ") : ""}`] });
  });

  it("where it cannot stay while files are replaced, it hands over and shows nothing", async () => {
    expect(await run({ looks: [FINISH] }, { quitsToFinish: true })).toEqual({ end: "handed-over", did: ["look: finish", "pages only", "hand over"] });
  });

  it("a hand-over that cannot start says so", async () => {
    const { end, did } = await run({ looks: [FINISH], handOver: { ok: false, message: "The updater could not be started (ENOENT)." } }, { quitsToFinish: true });
    expect(end).toBe("said");
    expect(did.at(-1)).toBe(`say: ${DID_NOT_START} | The updater could not be started (ENOENT). | The last update, to v2, did not finish, so this copy may not run yet.`);
  });
});

it("no order of findings reaches the server's start once any look has found an update", async () => {
  const kinds = [START, WAIT, FINISH, SAY];
  let runs = 0;
  // Every sequence of three findings, then a whole checkout: the start is reached only by two clean looks at the very beginning.
  for (const a of kinds) for (const b of kinds) for (const c of kinds) for (const quitsToFinish of [false, true]) for (const tried of [false, true]) {
    const { did } = await run({ looks: [a, b, c, START] }, { quitsToFinish, tried });
    runs++;
    const started = did.includes("START");
    expect(started, `${a.kind}, ${b.kind}, ${c.kind}`).toBe(a.kind === "start" && b.kind === "start");
    if (started) expect(did).toEqual(["look" + (tried ? " (tried)" : "") + ": start", "claim", "look" + (tried ? " (tried)" : "") + ": start", "START"]);
  }
  expect(runs).toBe(256);
});
