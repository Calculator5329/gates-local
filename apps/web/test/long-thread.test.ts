// Opening a 2,000-message thread, counted rather than timed: rows in the first
// commit, store subscriptions, matchMedia calls and the selectors one
// keystroke runs. Counts cannot be noisy, so the bounds are exact limits.
import { readFileSync } from "node:fs";
import { act, createElement } from "react";
import type { Root } from "react-dom/client";
import type { Message } from "@gates-local/contracts";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import type { State } from "../src/store.ts";
import { editDraft } from "../src/drafts.ts";
import { FakeDocument, FakeElement, FakeIFrame } from "./fake-dom.ts";

const runs = vi.hoisted(() => ({ selectors: 0 }));
vi.mock("../src/store.ts", async (original) => {
  const actual = await original<typeof import("../src/store.ts")>();
  return { ...actual, useStore: <T,>(selector: (s: State) => T): T => actual.useStore((s) => { runs.selectors++; return selector(s); }) };
});
vi.mock("../src/session.ts", () => ({ cancelImage: vi.fn(), retryImage: vi.fn(), reloadThread: vi.fn(), retry: vi.fn(), fileUrl: vi.fn() }));

/** The bounds this test holds the timeline to. */
const BOUND = {
  /** Turns in the first commit: Thread.tsx FIRST_TURNS. */
  firstCommitTurns: 40,
  /** The timeline's own reads; no saved row subscribes. */
  subscriptions: 10,
  /** No live reply is on screen, so nothing asks about reduced motion. */
  reducedMotionQueries: 0,
  selectorsPerKeystroke: 10,
} as const;

/** test/perf/fixture.ts seedLong(2000), as client messages. */
function longThread(threadId: string, messages: number, title = `Perf thousands ${messages}`): Message[] {
  return Array.from({ length: messages }, (_, i): Message => ({
    id: `m${i}`, threadId, createdAt: 1_762_500_000_000 + i, role: i % 2 ? "assistant" : "user",
    content: i % 2 ? `A measured answer.${i === messages - 1 ? ` ${title}` : ""}\n\n- First item\n- Second item\n\n\`\`\`ts\nconst value = 42;\n\`\`\`` : `Question ${i}`,
    ...(i % 2 ? { model: "qwen3.5:9b" } : {}),
  }));
}

const media: string[] = [];
const idle: (() => void)[] = [];
const doc = new FakeDocument();
let root: Root;
let store: typeof import("../src/store.ts");
/** Change listeners attached to reduced-motion queries and not yet removed. */
let motionListeners = 0;
const isMotion = (query: string) => query.includes("reduced-motion");
const matchMedia = (query: string) => {
  media.push(query);
  return {
    matches: false, media: query,
    addEventListener() { if (isMotion(query)) motionListeners++; },
    removeEventListener() { if (isMotion(query)) motionListeners--; },
  };
};
/** Idle time left as a callback asks for it, in order; none once these run out. */
let idleLeft: number[] = [];
const deadline = { didTimeout: false, timeRemaining: () => idleLeft.shift() ?? 0 };
const requestIdleCallback = (fn: IdleRequestCallback) => { idle.push(() => fn(deadline)); return idle.length; };
const cancelIdleCallback = () => {};

beforeAll(async () => {
  const win = { document: doc, HTMLIFrameElement: FakeIFrame, matchMedia, requestIdleCallback, cancelIdleCallback, addEventListener() {}, removeEventListener() {} };
  doc.defaultView = win;
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("window", win);
  vi.stubGlobal("document", doc);
  vi.stubGlobal("matchMedia", matchMedia);
  vi.stubGlobal("requestIdleCallback", requestIdleCallback);
  vi.stubGlobal("cancelIdleCallback", cancelIdleCallback);
  vi.stubGlobal("requestAnimationFrame", () => 0);
  vi.stubGlobal("cancelAnimationFrame", () => {});
  vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
  vi.stubGlobal("HTMLElement", FakeElement);
  Object.defineProperty(FakeElement.prototype, "previousElementSibling", { configurable: true, get(this: FakeElement) {
    let n = this.previousSibling;
    while (n !== null && !(n instanceof FakeElement)) n = n.previousSibling;
    return n;
  } });
  // react-dom decides at import whether it has a DOM, so it loads after the stubs
  const { createRoot } = await import("react-dom/client");
  store = await import("../src/store.ts");
  const container = doc.body.appendChild(doc.createElement("div"));
  root = createRoot(container as unknown as Element);
});
afterAll(() => {
  act(() => root.unmount());
  vi.unstubAllGlobals();
  Reflect.deleteProperty(FakeElement.prototype, "previousElementSibling");
});

const turns = () => doc.body.querySelectorAll(".turn");
const turnLabel = (el: FakeElement | undefined) => el?.textContent.slice(0, 40);
const sameElements = (now: FakeElement[], was: FakeElement[]) => now.length === was.length && now.every((el, i) => el === was[i]);
/** A turn marked not to fade in. */
const still = (el: FakeElement) => el.style.animation === "none";
/** A selector with a sibling combinator, outside brackets and parentheses. */
const sibling = (s: string) => /[+~]/.test(s.replace(/\[[^\]]*\]/g, "").replace(/\([^)]*\)/g, ""));

it("opens a 2,000-message thread with a bounded first commit and few subscriptions, then mounts the rest", async () => {
  const { Timeline } = await import("../src/Thread.tsx");
  const thread = longThread("long", 2000);
  store.setState({ messages: { long: thread }, catalog: [] });
  const before = store.listenerCount();
  media.length = 0;

  act(() => root.render(createElement(Timeline, { threadId: "long" })));
  const first = turns().length;
  const subscriptions = store.listenerCount() - before;
  const reduced = media.filter((q) => q.includes("reduced-motion")).length;
  const allMedia = media.length;

  runs.selectors = 0;
  act(() => editDraft("x"));
  const selectors = runs.selectors;

  console.info(JSON.stringify({ firstCommitTurns: first, subscriptions, matchMedia: allMedia, reducedMotionQueries: reduced, selectorsPerKeystroke: selectors }));
  expect(first, "turns mounted in the first commit").toBeLessThanOrEqual(BOUND.firstCommitTurns);
  expect(turnLabel(turns().at(-1)), "the first commit is the end of the thread").toContain("Perf thousands 2000");
  expect(subscriptions, "store subscriptions with the thread open").toBeLessThanOrEqual(BOUND.subscriptions);
  expect(reduced, "reduced-motion matchMedia calls").toBeLessThanOrEqual(BOUND.reducedMotionQueries);
  expect(selectors, "selectors run by one editDraft").toBeLessThanOrEqual(BOUND.selectorsPerKeystroke);

  // idle slices mount the older turns until the whole thread is in the DOM, in order
  for (let slices = 0; idle.length > 0; slices++) {
    expect(slices, "backfill ends").toBeLessThan(200);
    const next = idle.shift();
    act(() => next?.());
  }
  const all = turns();
  expect(all).toHaveLength(2000);
  expect(turnLabel(all[0])).toContain("Question 0");
  expect(turnLabel(all.at(-1))).toContain("Perf thousands 2000");
  expect(store.listenerCount() - before, "backfilled rows subscribe to nothing").toBe(subscriptions);
});

it("adds a turn at the end without unmounting the top of a part-mounted thread", async () => {
  const { Timeline } = await import("../src/Thread.tsx");
  const thread = longThread("grow", 200);
  act(() => store.setState({ messages: { grow: thread } }));
  act(() => root.render(createElement(Timeline, { threadId: "grow", key: "grow" })));
  const top = turns()[0];
  expect(turns()).toHaveLength(40);
  act(() => store.setState({ messages: { grow: [...thread, { id: "next", threadId: "grow", role: "user", content: "One more question", createdAt: 2 }] } }));
  expect(turns()).toHaveLength(41);
  expect(turns()[0], "the oldest mounted turn stays mounted").toBe(top);
  idle.length = 0;
});

it("keeps the live reply's element when it saves, and asks about reduced motion once", async () => {
  const { Timeline } = await import("../src/Thread.tsx");
  const thread = longThread("live", 100);
  const user: Message = { id: "ask", threadId: "live", role: "user", content: "Last question", createdAt: 3 };
  const live = { gen: 1, threadId: "live", turnId: "turn", userMessageId: "ask", model: "qwen3.5:9b", startedAt: 1, thinking: "", text: "The answer so far", tools: [], pendingUser: null };
  act(() => store.setState({ messages: { live: [...thread, user] }, turns: { live } }));
  media.length = 0;
  act(() => root.render(createElement(Timeline, { threadId: "live", key: "live" })));
  const writing = turns().at(-1);
  expect(writing?.getAttribute("aria-label")).toBe("Reply");
  act(() => store.setState({ turns: { live: { ...live, text: "The answer so far, and more" } } }));
  act(() => store.setState({ turns: { live: { ...live, text: "The answer so far, and more, then the end" } } }));
  act(() => store.setState({ turns: {}, messages: { live: [...thread, user, { id: "answer", threadId: "live", role: "assistant", content: "The answer so far, and more, then the end", createdAt: 4, model: "qwen3.5:9b" }] } }));
  const saved = turns().at(-1);
  expect(saved, "the save must not remount the reply").toBe(writing);
  expect(saved?.getAttribute("data-received")).toBe(String("The answer so far, and more, then the end".length));
  // no frame ran, so the reveal is still paced: a remounted saved row would show it all at once
  expect(Number(saved?.getAttribute("data-revealed"))).toBeLessThan("The answer so far, and more, then the end".length);
  expect(media.filter((q) => q.includes("reduced-motion")), "one reduced-motion query for the module").toHaveLength(1);
  idle.length = 0;
});

it("keeps the turn in view where it was while older turns mount above it", async () => {
  const { Timeline } = await import("../src/Thread.tsx");
  const thread = longThread("anchor", 200);
  act(() => store.setState({ messages: { anchor: thread }, turns: {} }));
  idle.length = 0;
  act(() => root.render(createElement(Timeline, { threadId: "anchor", key: "anchor" })));
  const tl = doc.body.querySelector(".tl");
  if (tl === null) throw new Error("no timeline");
  // every turn 100 px tall, stacked in order inside the scrolled timeline
  FakeElement.topOf = (el) => (el.classList.includes("turn") ? turns().indexOf(el) * 100 - tl.scrollTop : 0);
  try {
    tl.scrollTop = 2000;
    const watched = turns()[20];
    expect(watched?.getBoundingClientRect().top, "the reader is looking at the 21st mounted turn").toBe(0);
    while (idle.length > 0) {
      const next = idle.shift();
      act(() => next?.());
      expect(watched?.getBoundingClientRect().top, `with ${turns().length} turns mounted`).toBe(0);
    }
    expect(turns()).toHaveLength(200);
  } finally {
    FakeElement.topOf = null;
  }
});

/** The session's real chat event handler, with every effect a done event does not need refused. */
async function realChat() {
  const { createChat } = await import("../src/session/chat.ts");
  const { withMessage } = await import("../src/session/threads.ts");
  const { createServerState } = await import("../src/session/server-state.ts");
  return createChat({
    // the session's own, which publishes nothing for an update that returns nothing
    applyServerEvent: createServerState(store.getState, store.setState),
    call: async () => { throw new Error("unexpected RPC"); },
    codeOf: () => "unexpected",
    createThread: async () => null,
    creatingDraft: () => false,
    loadThread: async () => {},
    loading: () => true,
    noteMessage: () => {},
    withMessage,
    untrackedDone: () => {},
    openThread: () => {},
    blockingFor: async () => [],
    invalidateFits: () => {},
  });
}

const liveIn = (threadId: string, userMessageId: string | undefined, gen: number) =>
  ({ gen, threadId, turnId: "running", ...(userMessageId === undefined ? {} : { userMessageId }), model: "qwen3.5:9b", startedAt: 1, thinking: "", text: "Still writing", tools: [], pendingUser: null });

it("holds back the history that arrives in front of a reply that finished before it", async () => {
  const { Timeline } = await import("../src/Thread.tsx");
  const chat = await realChat();
  const thread = longThread("late-history", 2000);
  const answer = thread.at(-1);
  if (answer === undefined) throw new Error("no answer");
  // the thread opens on a running reply with no history cached yet
  act(() => store.setState({ messages: {}, turns: { "late-history": liveIn("late-history", "m1998", 30) }, threadId: "late-history", view: "thread" }));
  idle.length = 0;
  act(() => root.render(createElement(Timeline, { threadId: "late-history", key: "late-history" })));
  expect(turns()).toHaveLength(1);
  // the done handler caches the one message it has (session/chat.ts withMessage)
  act(() => chat.onChatEvent({ threadId: "late-history", turnId: "running", event: { type: "done", message: answer, stopReason: "stop" } }));
  expect(store.getState().messages["late-history"]).toHaveLength(1);
  // then the history arrives with that reply at its end
  act(() => store.setState({ messages: { "late-history": thread } }));
  expect(turns(), "turns in front of the mounted reply are held back like at open").toHaveLength(BOUND.firstCommitTurns);
  expect(turnLabel(turns().at(-1))).toContain("Perf thousands 2000");
  while (idle.length > 0) act(() => idle.shift()?.());
  expect(turns()).toHaveLength(2000);
});

it("keeps the reply on screen, the same element in the same place, when the history replaces a partial cache", async () => {
  const { Timeline } = await import("../src/Thread.tsx");
  const chat = await realChat();
  const thread = longThread("partial", 2000);
  const [question, answer] = thread.slice(-2);
  if (question === undefined || answer === undefined) throw new Error("no last turn");
  // the admitted question is cached on its own (session/chat.ts), and its reply is running
  act(() => store.setState({ messages: { partial: [question] }, turns: { partial: liveIn("partial", question.id, 31) }, threadId: "partial", view: "thread" }));
  idle.length = 0;
  act(() => root.render(createElement(Timeline, { threadId: "partial", key: "partial" })));
  const tl = doc.body.querySelector(".tl");
  if (tl === null) throw new Error("no timeline");
  FakeElement.topOf = (el) => (el.classList.includes("turn") ? turns().indexOf(el) * 100 - tl.scrollTop : 0);
  try {
    const reply = turns()[1];
    expect(reply?.getAttribute("aria-label")).toBe("Reply");
    const top = reply?.getBoundingClientRect().top;
    act(() => chat.onChatEvent({ threadId: "partial", turnId: "running", event: { type: "done", message: answer, stopReason: "stop" } }));
    expect(turns()[1], "the save keeps the reply").toBe(reply);
    act(() => store.setState({ messages: { partial: thread } }));
    expect(turns()).toHaveLength(BOUND.firstCommitTurns);
    expect(turns().at(-1), "the history keeps the reply").toBe(reply);
    expect(reply?.getBoundingClientRect().top, "the reply stays where the reader saw it").toBe(top);
  } finally {
    FakeElement.topOf = null;
  }
  idle.length = 0;
});

it("keeps one reduced-motion listener for the module, however many replies were live, and none once they are gone", async () => {
  const { Timeline } = await import("../src/Thread.tsx");
  let thread: Message[] = [];
  act(() => store.setState({ messages: { session: [] }, turns: {} }));
  idle.length = 0;
  act(() => root.render(createElement(Timeline, { threadId: "session", key: "session" })));
  for (let i = 0; i < 3; i++) {
    const user: Message = { id: `user-${i}`, threadId: "session", role: "user", content: `Ask ${i}`, createdAt: i };
    thread = [...thread, user];
    act(() => store.setState({ messages: { session: thread }, turns: { session: { ...liveIn("session", user.id, 40 + i), text: "Written" } } }));
    thread = [...thread, { id: `answer-${i}`, threadId: "session", role: "assistant", content: "Written", createdAt: i }];
    act(() => store.setState({ messages: { session: thread }, turns: {} }));
  }
  expect(motionListeners, "one browser listener, shared by every pacing reply").toBe(1);
  act(() => root.render(createElement("div")));
  expect(motionListeners, "the last reply gone takes the listener with it").toBe(0);
  idle.length = 0;
});

it("mounts further slices in one idle callback while its deadline has room", async () => {
  const { Timeline } = await import("../src/Thread.tsx");
  act(() => store.setState({ messages: { roomy: longThread("roomy", 400) }, turns: {} }));
  idle.length = 0;
  act(() => root.render(createElement(Timeline, { threadId: "roomy", key: "roomy" })));
  expect(turns()).toHaveLength(40);
  // room after the first slice, room after the second, then too little for a fourth
  idleLeft = [40, 20, 10];
  act(() => idle.shift()?.());
  expect(turns()).toHaveLength(160);
  idleLeft = [];
  idle.length = 0;
});

it("keeps a fully mounted thread mounted, the same elements, when its first turn is deleted", async () => {
  const { Timeline } = await import("../src/Thread.tsx");
  const thread = longThread("gone-first", 2000);
  act(() => store.setState({ messages: { "gone-first": thread }, turns: {} }));
  idle.length = 0;
  act(() => root.render(createElement(Timeline, { threadId: "gone-first", key: "gone-first" })));
  while (idle.length > 0) act(() => idle.shift()?.());
  const before = [...turns()];
  expect(before).toHaveLength(2000);
  // the first question and its answer deleted (an answer left without its question is keyed anew)
  act(() => store.setState({ messages: { "gone-first": thread.slice(2) } }));
  const after = [...turns()];
  expect(after, "everything but the deleted turns stays mounted").toHaveLength(1998);
  expect(after[0], "the next question is now first").toBe(before[2]);
  expect(after[18], "the turn being read is the same element").toBe(before[20]);
  idle.length = 0;
});

it("changes nothing mounted when a turn in front of a part-mounted thread, or its first mounted turn, is deleted", async () => {
  const { Timeline } = await import("../src/Thread.tsx");
  const thread = longThread("gone-early", 2000);
  act(() => store.setState({ messages: { "gone-early": thread }, turns: {} }));
  idle.length = 0;
  act(() => root.render(createElement(Timeline, { threadId: "gone-early", key: "gone-early" })));
  act(() => idle.shift()?.());
  const before = [...turns()];
  expect(before).toHaveLength(80);
  const early = thread.filter((_, i) => i !== 5);
  act(() => store.setState({ messages: { "gone-early": early } }));
  expect(sameElements([...turns()], before), "a turn deleted in front of the mounted ones").toBe(true);
  // the first mounted turn is question 1,920 of the original thread, 1,919 now: it goes with its answer
  act(() => store.setState({ messages: { "gone-early": early.filter((_, i) => i !== 1919 && i !== 1920) } }));
  expect(sameElements([...turns()], before.slice(2)), "the first mounted turns deleted: the rest stay, the same elements").toBe(true);
  idle.length = 0;
});

it("mounts older turns above the view without their entrance fade, and keeps the fade on the first screen and on new turns", async () => {
  // the fade of turns nobody sees kept frames running through the backfill, each one laying out
  // and observing every mounted turn; marked before they are first styled, they never start one
  const { Timeline } = await import("../src/Thread.tsx");
  const thread = longThread("fade", 120);
  act(() => store.setState({ messages: { fade: thread }, turns: {} }));
  idle.length = 0;
  act(() => root.render(createElement(Timeline, { threadId: "fade", key: "fade" })));
  const screen = [...turns()];
  expect(screen).toHaveLength(40);
  act(() => idle.shift()?.());
  expect(turns()).toHaveLength(80);
  expect(turns().slice(0, 40).filter(still), "the slice mounted above the view").toHaveLength(40);
  expect(screen.filter(still), "the first screen keeps its fade").toEqual([]);
  act(() => store.setState({ messages: { fade: [...thread, { id: "new", threadId: "fade", role: "user", content: "A new question", createdAt: 5 }] } }));
  expect(turns()).toHaveLength(81);
  expect(turns().slice(40).filter(still), "the first screen and a new turn at the end fade in").toEqual([]);
  idle.length = 0;
});

it("spaces the turns without a rule that looks at the element before a turn", () => {
  // `.turn+.turn` made each slice of older turns mounted at the top restyle and re-lay out every
  // turn below it: in the perf comparison, a 2,000-turn thread's whole-mount style time fell from
  // about 970 ms to 220 ms without it
  const css = readFileSync(new URL("../src/styles.css", import.meta.url), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
  const selectors = [...css.matchAll(/([^{}]+)\{/g)].flatMap((m) => (m[1] ?? "").split(",")).map((s) => s.trim()).filter((s) => !s.startsWith("@"));
  expect(selectors.filter((s) => sibling(s) && /\.(turn|stop-note|err-line)\b/.test(s)), "sibling combinators on timeline turns").toEqual([]);
  expect(selectors.filter(sibling).length, "the check still finds sibling rules elsewhere").toBeGreaterThan(0);
});
