/// <reference lib="dom" />
// What one action cost, in numbers that do not depend on the clock.

export interface CdpMetric { name: string; value: number }
export type MetricSnapshot = ReadonlyMap<string, number>
export interface Row { action: string; unit: "ms" | "count"; value: number }

export function snapshot(metrics: readonly CdpMetric[]): MetricSnapshot {
  return new Map(metrics.map(metric => [metric.name, metric.value]));
}

/** Counters restart when a navigation swaps the document, so the later value is the whole cost. */
export function metricDelta(before: MetricSnapshot, after: MetricSnapshot, name: string): number {
  const end = after.get(name);
  if (end === undefined) throw new Error(`Browser did not report ${name}`);
  const start = before.get(name) ?? 0;
  return end >= start ? end - start : end;
}

const SECONDS_TO_MS = 1000;
/** CPU spent by the page's main thread. ThreadTime is the whole; the rest say where it went. */
const CPU_ROWS = [["cpu-thread", "ThreadTime"], ["cpu-task", "TaskDuration"], ["cpu-script", "ScriptDuration"], ["cpu-layout", "LayoutDuration"], ["cpu-style", "RecalcStyleDuration"]] as const;
const COUNT_ROWS = [["layouts", "LayoutCount"], ["style-recalcs", "RecalcStyleCount"]] as const;

export function costRows(action: string, before: MetricSnapshot, after: MetricSnapshot): Row[] {
  return [
    ...CPU_ROWS.map(([suffix, name]): Row => ({ action: `${action}.${suffix}`, unit: "ms", value: metricDelta(before, after, name) * SECONDS_TO_MS })),
    ...COUNT_ROWS.map(([suffix, name]): Row => ({ action: `${action}.${suffix}`, unit: "count", value: metricDelta(before, after, name) })),
  ];
}

export interface ReactCounts { commits: number; renders: number }
export interface NetworkCounts { requests: number; bytes: number; wsIn: number; wsOut: number; wsBytes: number }
declare global { interface Window { perfReact?: ReactCounts } }

/** Bytes in one WebSocket frame as the DevTools protocol reports it: text as a string, binary as base64. */
export function frameBytes(opcode: number, payload: string): number {
  return Buffer.byteLength(payload, opcode === 2 ? "base64" : "utf8");
}

export function emptyNetwork(): NetworkCounts {
  return { requests: 0, bytes: 0, wsIn: 0, wsOut: 0, wsBytes: 0 };
}

export function counterRows(action: string, react: { before: ReactCounts; after: ReactCounts }, network: NetworkCounts, elements: number): Row[] {
  return [
    { action: `${action}.react-commits`, unit: "count", value: react.after.commits - react.before.commits },
    { action: `${action}.react-renders`, unit: "count", value: react.after.renders - react.before.renders },
    { action: `${action}.requests`, unit: "count", value: network.requests },
    { action: `${action}.bytes`, unit: "count", value: network.bytes },
    { action: `${action}.ws-in`, unit: "count", value: network.wsIn },
    { action: `${action}.ws-out`, unit: "count", value: network.wsOut },
    { action: `${action}.ws-bytes`, unit: "count", value: network.wsBytes },
    { action: `${action}.dom-elements`, unit: "count", value: elements },
  ];
}

interface FiberLike { tag: number; flags: number; alternate: FiberLike | null; child: FiberLike | null; sibling: FiberLike | null }

/**
 * Counts commits and rendered components through the hook React already calls
 * for its developer tools. Installed before the app loads, in the separate
 * counter repetition only, so timed repetitions run the plain production path.
 */
export function browserReactHook(): void {
  const counts = { commits: 0, renders: 0 };
  const componentTags = new Set([0, 1, 11, 14, 15]);
  const PERFORMED_WORK = 1;
  const walk = (fiber: FiberLike): void => {
    if (componentTags.has(fiber.tag) && (fiber.flags & PERFORMED_WORK) !== 0) counts.renders++;
    // A child pointer shared with the previous tree means React skipped this subtree.
    if (fiber.alternate !== null && fiber.child === fiber.alternate.child) return;
    for (let child = fiber.child; child !== null; child = child.sibling) walk(child);
  };
  const renderers = new Map<number, unknown>();
  Object.defineProperty(window, "__REACT_DEVTOOLS_GLOBAL_HOOK__", {
    configurable: true,
    value: {
      renderers, supportsFiber: true, isDisabled: false,
      inject(renderer: unknown) { renderers.set(renderers.size + 1, renderer); return renderers.size; },
      checkDCE() {}, onScheduleFiberRoot() {}, onCommitFiberUnmount() {}, onPostCommitFiberRoot() {},
      onCommitFiberRoot(_id: number, root: { current: FiberLike }) { counts.commits++; walk(root.current); },
    },
  });
  window.perfReact = counts;
}

interface ProfileNode { id: number; callFrame: { functionName: string; url: string; lineNumber: number } }
export interface CpuProfile { nodes: readonly ProfileNode[]; samples?: readonly number[]; timeDeltas?: readonly number[] }
export interface HotSpot { name: string; selfMs: number }

/** Where a profile spent its samples, largest first, by function and file. */
export function hotSpots(profile: CpuProfile, limit = 15): HotSpot[] {
  const samples = profile.samples ?? [], deltas = profile.timeDeltas ?? [];
  const nodes = new Map(profile.nodes.map(node => [node.id, node]));
  const self = new Map<string, number>();
  samples.forEach((id, index) => {
    const frame = nodes.get(id)?.callFrame;
    if (!frame) return;
    const file = frame.url.split("/").at(-1) ?? "";
    const name = file ? `${frame.functionName || "(anonymous)"} ${file}:${frame.lineNumber + 1}` : frame.functionName;
    self.set(name, (self.get(name) ?? 0) + (deltas[index] ?? 0) / 1000);
  });
  return [...self].filter(([name]) => name !== "(idle)").map(([name, selfMs]) => ({ name, selfMs })).toSorted((a, b) => b.selfMs - a.selfMs).slice(0, limit);
}
