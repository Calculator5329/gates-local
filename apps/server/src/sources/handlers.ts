import type { Handlers } from "../ws/server.ts";
import type { Sources } from "./index.ts";

export function createSourcesHandlers(deps: { sources: Sources }) {
  return {
    "sources.list": () => deps.sources.list(),
    "sources.add": input => deps.sources.add(input),
    "sources.remove": ({ id }) => { deps.sources.remove(id); return { id }; },
    "sources.refresh": ({ id }) => deps.sources.refresh(id),
  } satisfies Partial<Handlers>;
}
