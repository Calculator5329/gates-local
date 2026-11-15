import { callRule } from "./rule.ts";

const HOOKS = new Set(["useEffect", "useLayoutEffect", "useInsertionEffect"]);

export default callRule(
  "Every React effect says what it keeps in step.",
  call => HOOKS.has(call.name) && (call.on === undefined || call.on === "React"),
  "An effect is right only when it keeps something outside React in step with this component while it is mounted: "
    + "a DOM node, a listener, a subscription, the connection. "
    + "If it works a value out from props or state, compute it during render. "
    + "If it answers a click or a key, do it in that handler. "
    + "If it resets state when a prop changes, key the component on that prop. "
    + "If it copies a value into the store or up to a parent, do that where the value changes. "
    + "If it stays, name what it keeps in step on the line above: "
    + "`// oxlint-disable-next-line gates/effect-needs-reason -- <what it keeps in step, and why>`.",
);
