export interface ReplayFrame { readonly socket: string; readonly event: string }

/** Dependencies describe work; emitted frames describe each socket's FIFO. */
export interface ReplayEvent<World> {
  readonly name: string;
  readonly after?: readonly string[];
  readonly delivery?: boolean;
  readonly emit?: (prefix: readonly string[]) => readonly ReplayFrame[];
  readonly discard?: readonly string[];
  run(world: World): void | Promise<void>;
}

export interface ReplayScenario<World> {
  readonly name: string;
  readonly events: readonly ReplayEvent<World>[];
  readonly initialFrames?: readonly ReplayFrame[];
  create(): Promise<World>;
  check(world: World, order: readonly string[], complete: boolean): void;
  dispose(world: World): Promise<void>;
}

/** Enumerate topological sorts in declaration order, with an explicit coverage bound. */
export function schedules<World>(events: readonly ReplayEvent<World>[], limit = 256, initialFrames: readonly ReplayFrame[] = []): { orders: string[][]; exhaustive: boolean } {
  if (!Number.isSafeInteger(limit) || limit < 1) throw new Error("Replay limit must be a positive integer");
  const names = events.map((event) => event.name);
  if (new Set(names).size !== names.length) throw new Error("Duplicate replay event name");
  for (const event of events) for (const dependency of event.after ?? []) {
    if (!names.includes(dependency)) throw new Error(`Unknown dependency ${dependency} for ${event.name}`);
  }
  const orders: string[][] = [];
  let exhaustive = true;
  function visit(prefix: string[], remaining: readonly ReplayEvent<World>[], frames: readonly ReplayFrame[]): void {
    if (remaining.length === 0) {
      if (orders.length === limit) { exhaustive = false; return; }
      orders.push(prefix);
      return;
    }
    const ready = available(remaining, prefix, frames);
    if (ready.length === 0) throw new Error("Cyclic replay dependencies");
    for (const event of ready) {
      const next = [...prefix, event.name];
      visit(next, remaining.filter((candidate) => candidate !== event), advance(event, next, frames));
      if (!exhaustive) return;
    }
  }
  visit([], events, initialFrames);
  return { orders, exhaustive };
}

function available<World>(events: readonly ReplayEvent<World>[], prefix: readonly string[], frames: readonly ReplayFrame[]): ReplayEvent<World>[] {
  return events.filter((event) => {
    if (!(event.after ?? []).every((name) => prefix.includes(name))) return false;
    if (!event.delivery) return true;
    const frame = frames.find((candidate) => candidate.event === event.name);
    // Cancelled actions and sends to closed sockets have no frame to deliver.
    return !frame || frames.find((candidate) => candidate.socket === frame.socket)?.event === event.name;
  });
}

function advance<World>(event: ReplayEvent<World>, prefix: readonly string[], frames: readonly ReplayFrame[]): ReplayFrame[] {
  return [...frames.filter((frame) => frame.event !== event.name && !event.discard?.includes(frame.socket)), ...(event.emit?.(prefix) ?? [])];
}

/** Exhaust small graphs; otherwise mix a DFS witness with fixed-seed Kahn samples. */
export function explore<World>(events: readonly ReplayEvent<World>[], limit = 96, initialFrames: readonly ReplayFrame[] = []): { orders: string[][]; exhaustive: boolean } {
  const coverage = schedules(events, limit, initialFrames);
  if (coverage.exhaustive) return coverage;
  const orders = [coverage.orders[0] ?? []];
  const seen = new Set(orders.map((order) => JSON.stringify(order)));
  let seed = 0x51a01;
  const random = () => { seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5; return (seed >>> 0) / 0x1_0000_0000; };
  for (let attempt = 0; orders.length < limit && attempt < limit * 100; attempt++) {
    let remaining = [...events], frames = [...initialFrames];
    const order: string[] = [];
    // Stable priorities also sample long delays, rather than repeatedly giving
    // an early-ready event a fresh chance that biases it toward early delivery.
    const priorities = new Map(events.map((event) => [event, random()]));
    while (remaining.length) {
      const ready = available(remaining, order, frames);
      // Include witnesses that defer each event in turn before random sampling.
      // This exercises independent recipients that an early DFS prefix misses.
      const deferred = events[attempt]?.name;
      const next = deferred === undefined ? ready.reduce<ReplayEvent<World> | undefined>((best, event) =>
        !best || (priorities.get(event) ?? 0) < (priorities.get(best) ?? 0) ? event : best, undefined)
        : ready.find((event) => event.name !== deferred) ?? ready[0];
      if (!next) throw new Error("Deadlocked replay frame constraints");
      order.push(next.name);
      frames = advance(next, order, frames);
      remaining = remaining.filter((event) => event !== next);
    }
    const key = JSON.stringify(order);
    if (!seen.has(key)) { seen.add(key); orders.push(order); }
  }
  return { orders, exhaustive: false };
}

/** A printed order is a complete regression, including dependency validation. */
export function regression<World>(events: readonly ReplayEvent<World>[], value: string, initialFrames: readonly ReplayFrame[] = []): string[] {
  const parsed: unknown = JSON.parse(value);
  if (!Array.isArray(parsed) || !parsed.every((name): name is string => typeof name === "string")) throw new Error("Replay order must be a JSON string array");
  if (parsed.length !== events.length || new Set(parsed).size !== events.length) throw new Error("Replay order must contain every event exactly once");
  const seen = new Set<string>();
  let frames = [...initialFrames];
  for (const name of parsed) {
    const event = events.find((candidate) => candidate.name === name);
    if (!event || !(event.after ?? []).every((dependency) => seen.has(dependency))) throw new Error(`Invalid replay event or causal order: ${name}`);
    if (!available([event], [...seen], frames).length) throw new Error(`Replay violates socket FIFO: ${name}`);
    seen.add(name);
    frames = advance(event, [...seen], frames);
  }
  return parsed;
}

export async function replay<World>(scenario: ReplayScenario<World>, options: { limit?: number; order?: string } = {}): Promise<number> {
  const coverage = options.order
    ? { orders: [regression(scenario.events, options.order, scenario.initialFrames)], exhaustive: false }
    : explore(scenario.events, options.limit, scenario.initialFrames);
  const coverageLabel = coverage.exhaustive ? "exhaustive" : options.order ? "single regression" : "bounded fixed-seed sample; not exhaustive";
  let runs = 0;
  for (const order of coverage.orders) {
    const world = await scenario.create();
    const prefix: string[] = [];
    try {
      for (const name of order) {
        const event = scenario.events.find((candidate) => candidate.name === name);
        if (!event) throw new Error(`Missing event ${name}`);
        prefix.push(name);
        await event.run(world);
        scenario.check(world, prefix, prefix.length === order.length);
      }
      runs++;
    } catch (cause) {
      const line = `${scenario.name}: ${cause instanceof Error ? cause.message : String(cause)}\nOrder ${runs + 1}/${coverage.orders.length} (${coverageLabel})\nAfter: ${prefix.join(" -> ")}\nREPLAY_ORDER='${JSON.stringify(order)}'`;
      console.error(line);
      throw new Error(line, { cause });
    } finally {
      await scenario.dispose(world);
    }
  }
  console.info(`${scenario.name}: ${runs} orders (${coverageLabel})`);
  return runs;
}
