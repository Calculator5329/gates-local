import { Children, isValidElement, type ReactNode } from "react";
import { afterEach, expect, it, vi } from "vitest";

// A small hook host exercises the actual component's handlers across unmount
// and remount. The browser journey covers the same navigation with real React.
const host = vi.hoisted(() => ({ slots: [] as unknown[], at: 0, fresh: true, cleanups: [] as (() => void)[], request: vi.fn() }));
vi.mock("react", async original => {
  const react = await original<typeof import("react")>();
  return { ...react,
    useState: (initial?: unknown) => {
      const at = host.at++;
      if (host.fresh) host.slots[at] = initial;
      return [host.slots[at], (value: unknown) => { host.slots[at] = typeof value === "function" ? (value as (old: unknown) => unknown)(host.slots[at]) : value; }];
    },
    useRef: (initial: unknown) => {
      const at = host.at++;
      if (host.fresh) host.slots[at] = { current: initial };
      return host.slots[at];
    },
    useEffect: (effect: () => () => void) => { if (host.fresh) host.cleanups.push(effect()); },
  };
});
vi.mock("../src/session.ts", () => ({ libraryRequest: host.request, applyServerEvent: (run: () => void) => run() }));
vi.mock("../src/store.ts", () => ({ NA: Symbol("NA"), useStore: () => [] }));
import LibraryImports from "../src/LibraryImports.tsx";

function leaveSettings() {
  for (const cleanup of host.cleanups.splice(0)) cleanup();
  host.slots = []; host.at = 0; host.fresh = true;
}
function render() { host.at = 0; const tree = LibraryImports(); host.fresh = false; return tree; }
function find(tree: ReactNode, type: string, text?: string) {
  let found: { children?: ReactNode; onClick?: () => void; onChange?: (event: { target: { value: string } }) => void } | undefined;
  const visit = (node: ReactNode) => Children.forEach(node, child => {
    if (!isValidElement<{ children?: ReactNode; onClick?: () => void; onChange?: (event: { target: { value: string } }) => void }>(child)) return;
    if (child.type === type && (text === undefined || child.props.children === text)) found = child.props;
    if (child.props.children) visit(child.props.children);
  });
  visit(tree); if (!found) throw new Error(`Missing ${type} ${text ?? ""}`); return found;
}
afterEach(() => { leaveSettings(); host.request.mockReset(); });

it.each(["cancelled", "error"] as const)("Retry after leaving Library and returning uses the %s job's repository (DG-02)", async state => {
  const url = "https://github.com/example/docs";
  let jobs: { id: string; kind: "repository"; key: string; label: string; state: string; bytes: number }[] = [];
  host.request.mockImplementation(async (method: string, params: { url?: string }) => {
    if (method === "sources.imports") return { samples: [], jobs };
    jobs = [{ id: "job", kind: "repository", key: params.url ?? "", label: "example/docs", state: "cloning", bytes: 0 }];
    return jobs[0];
  });
  find(render(), "input").onChange!({ target: { value: url } });
  find(render(), "button", "Clone").onClick!();
  await Promise.resolve(); await Promise.resolve();
  leaveSettings(); jobs = [{ ...jobs[0]!, state }];
  render(); await Promise.resolve(); await Promise.resolve();
  find(render(), "button", "Retry").onClick!();
  expect(host.request).toHaveBeenLastCalledWith("sources.clone", { url });
  leaveSettings(); jobs = [{ ...jobs[0]!, state }];
  render(); await Promise.resolve(); await Promise.resolve();
  const other = "https://github.com/example/other";
  find(render(), "input").onChange!({ target: { value: other } });
  find(render(), "button", "Clone").onClick!();
  expect(host.request).toHaveBeenLastCalledWith("sources.clone", { url: other });
});
