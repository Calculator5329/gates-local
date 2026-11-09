/** A small causal schedule, independent of the product and test runner. */
export interface ReplayEvent<World> {
  readonly name: string;
  readonly after?: readonly string[];
  run(world: World): void | Promise<void>;
}

export interface ReplayScenario<World> {
  readonly name: string;
  readonly events: readonly ReplayEvent<World>[];
  create(): Promise<World>;
  check(world: World, order: readonly string[], complete: boolean): void;
  dispose(world: World): Promise<void>;
}

/** Enumerate topological sorts in declaration order, with an explicit coverage bound. */
export function schedules<World>(events: readonly ReplayEvent<World>[], limit = 256): { orders: string[][]; exhaustive: boolean } {
  if (!Number.isSafeInteger(limit) || limit < 1) throw new Error("Replay limit must be a positive integer");
  const names = events.map((event) => event.name);
  if (new Set(names).size !== names.length) throw new Error("Duplicate replay event name");
  for (const event of events) for (const dependency of event.after ?? []) {
    if (!names.includes(dependency)) throw new Error(`Unknown dependency ${dependency} for ${event.name}`);
  }
  const orders: string[][] = [];
  let exhaustive = true;
  function visit(prefix: string[], remaining: readonly ReplayEvent<World>[]): void {
    if (remaining.length === 0) {
      if (orders.length === limit) { exhaustive = false; return; }
      orders.push(prefix);
      return;
    }
    const ready = remaining.filter((event) => (event.after ?? []).every((name) => prefix.includes(name)));
    if (ready.length === 0) throw new Error("Cyclic replay dependencies");
    for (const event of ready) {
      visit([...prefix, event.name], remaining.filter((candidate) => candidate !== event));
      if (!exhaustive) return;
    }
  }
  visit([], events);
  return { orders, exhaustive };
}

/** A printed order is a complete regression, including dependency validation. */
export function regression<World>(events: readonly ReplayEvent<World>[], value: string): string[] {
  const parsed: unknown = JSON.parse(value);
  if (!Array.isArray(parsed) || !parsed.every((name): name is string => typeof name === "string")) throw new Error("Replay order must be a JSON string array");
  if (parsed.length !== events.length || new Set(parsed).size !== events.length) throw new Error("Replay order must contain every event exactly once");
  const seen = new Set<string>();
  for (const name of parsed) {
    const event = events.find((candidate) => candidate.name === name);
    if (!event || !(event.after ?? []).every((dependency) => seen.has(dependency))) throw new Error(`Invalid replay event or causal order: ${name}`);
    seen.add(name);
  }
  return parsed;
}

export async function replay<World>(scenario: ReplayScenario<World>, options: { limit?: number; order?: string } = {}): Promise<number> {
  const coverage = options.order
    ? { orders: [regression(scenario.events, options.order)], exhaustive: false }
    : schedules(scenario.events, options.limit);
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
      const line = `${scenario.name}: ${cause instanceof Error ? cause.message : String(cause)}\nOrder ${runs + 1}/${coverage.orders.length}${coverage.exhaustive ? " (exhaustive enumeration)" : ""}\nAfter: ${prefix.join(" -> ")}\nREPLAY_ORDER='${JSON.stringify(order)}'`;
      console.error(line);
      throw new Error(line, { cause });
    } finally {
      await scenario.dispose(world);
    }
  }
  console.info(`${scenario.name}: ${runs} orders (${coverage.exhaustive ? "exhaustive" : options.order ? "single regression" : "bounded DFS prefix; split this scenario for exhaustive coverage"})`);
  return runs;
}
