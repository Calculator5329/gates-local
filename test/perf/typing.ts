/// <reference lib="dom" />
// Where React work lands while someone types during a reply: the composer,
// the reply that is streaming, or anywhere else. Every function here runs in
// the page as an init script, so each is self-contained.

export interface RegionCounts { composer: number; live: number; elsewhere: number; where: Record<string, number> }
export interface LongTask { start: number; duration: number }
declare global { interface Window { perfRegions?: RegionCounts; perfLong?: LongTask[]; perfBusy?: { on: boolean } } }

interface HookSlot { memoizedState: unknown; next: HookSlot | null }
interface RegionFiber { tag: number; flags: number; child: RegionFiber | null; sibling: RegionFiber | null; return: RegionFiber | null; alternate: RegionFiber | null; stateNode: unknown; memoizedState: HookSlot | null }
interface RegionHook { onCommitFiberRoot: (id: number, root: { current: RegionFiber }, ...rest: unknown[]) => void }

/**
 * Wraps the counting hook from counters.ts, so it must be added after it.
 * A rendered component belongs to the region of its first DOM element, or of
 * its nearest DOM parent when it renders none. The composer is `.cw` (or the
 * new-chat slot) without the banner above it; the live reply is the assistant
 * turn holding the streaming text (`.md.live`), not an interrupted earlier one.
 */
export function browserRegionHook(): void {
  const hook = Reflect.get(window, "__REACT_DEVTOOLS_GLOBAL_HOOK__") as RegionHook | undefined;
  if (!hook) return;
  const counts: RegionCounts = { composer: 0, live: 0, elsewhere: 0, where: {} };
  const componentTags = new Set([0, 1, 11, 14, 15]);
  const HOST = 5, PERFORMED_WORK = 1;
  const firstElement = (fiber: RegionFiber): Element | null => {
    const stack: RegionFiber[] = fiber.child ? [fiber.child] : [];
    while (stack.length) {
      const next = stack.pop()!;
      if (next.tag === HOST && next.stateNode instanceof Element) return next.stateNode;
      if (next.sibling) stack.push(next.sibling);
      if (next.child) stack.push(next.child);
    }
    for (let up = fiber.return; up; up = up.return) if (up.tag === HOST && up.stateNode instanceof Element) return up.stateNode;
    return null;
  };
  const classify = (fiber: RegionFiber) => {
    const el = firstElement(fiber);
    const region = !el ? "elsewhere"
      : el.closest(".turn.a")?.querySelector(".md.live") ? "live"
      : el.closest(".cw, #draftComposerSlot") && !el.closest(".banner-slot") ? "composer"
      : "elsewhere";
    counts[region]++;
    if (region !== "live") {
      const label = `${region} ${el ? `${el.tagName.toLowerCase()}${el.id ? `#${el.id}` : ""}${el.classList[0] ? `.${el.classList[0]}` : ""}` : "(no element)"}`;
      counts.where[label] = (counts.where[label] ?? 0) + 1;
    }
  };
  // Where a re-render began: a component that rendered under one that did not,
  // and which of its hook slots hold a new value (a store read, a state).
  const began = (fiber: RegionFiber) => {
    const changed: number[] = [];
    let now = fiber.memoizedState, was = fiber.alternate?.memoizedState;
    for (let slot = 0; now && slot < 80; slot++, now = now.next, was = was?.next) if (now.memoizedState !== was?.memoizedState) changed.push(slot);
    const el = firstElement(fiber);
    const label = `began ${el ? `${el.tagName.toLowerCase()}${el.id ? `#${el.id}` : ""}${el.classList[0] ? `.${el.classList[0]}` : ""}` : "(no element)"} hooks [${changed.join(" ")}]`;
    counts.where[label] = (counts.where[label] ?? 0) + 1;
  };
  const walk = (fiber: RegionFiber, parentWorked = false): void => {
    const component = componentTags.has(fiber.tag), worked = component && (fiber.flags & PERFORMED_WORK) !== 0;
    if (worked) { classify(fiber); if (!parentWorked && fiber.alternate !== null) began(fiber); }
    if (fiber.alternate !== null && fiber.child === fiber.alternate.child) return;
    for (let child = fiber.child; child !== null; child = child.sibling) walk(child, component ? worked : parentWorked);
  };
  const prior = hook.onCommitFiberRoot;
  hook.onCommitFiberRoot = function (id, root, ...rest) { prior.call(hook, id, root, ...rest); walk(root.current); };
  window.perfRegions = counts;
}

/** Every long task since the document started, so a page load is covered too. */
export function browserLongTasks(): void {
  const tasks: LongTask[] = [];
  window.perfLong = tasks;
  try { new PerformanceObserver(list => { for (const entry of list.getEntries()) tasks.push({ start: entry.startTime, duration: entry.duration }); }).observe({ type: "longtask", buffered: true }); }
  catch { /* no long-task support: the rows read zero and the busy state's spins would show it */ }
}

/** The main thread busy in back-to-back 100 ms tasks, as in test/e2e/perf.spec.ts. */
export function browserBusyStart(): void {
  const state = { on: true };
  window.perfBusy = state;
  const channel = new MessageChannel();
  channel.port1.addEventListener("message", () => {
    if (!state.on) return;
    const end = performance.now() + 100;
    while (performance.now() < end) { /* spin */ }
    channel.port2.postMessage(0);
  });
  channel.port1.start();
  channel.port2.postMessage(0);
}

export function browserBusyStop(): void { if (window.perfBusy) window.perfBusy.on = false; }

/** Long tasks that started after `from`: how many, and the longest. */
export function longSince(tasks: readonly LongTask[], from: number): { count: number; longest: number } {
  const after = tasks.filter(task => task.start >= from);
  return { count: after.length, longest: Math.max(0, ...after.map(task => task.duration)) };
}
