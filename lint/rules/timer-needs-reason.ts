import { callRule } from "./rule.ts";

const TIMERS = new Set(["setTimeout", "setInterval", "requestAnimationFrame", "requestIdleCallback", "queueMicrotask"]);
const GLOBALS = new Set(["window", "globalThis", "self"]);

export default callRule(
  "Every timer and deferred call says what it waits for.",
  call => TIMERS.has(call.name) && (call.on === undefined || GLOBALS.has(call.on)),
  "A timer is right only when time is the point: a debounce, a paced reveal, a limit on a real wait, one frame to measure layout. "
    + "If it waits for something to finish, await that thing or listen for its event. "
    + "If a short delay makes an ordering problem go away, fix the order. "
    + "If it shows something late, the screen moves: draw it whole the first time. "
    + "If it stays, name what it waits for on the line above: "
    + "`// oxlint-disable-next-line gates/timer-needs-reason -- <what it waits for, and why this long>`.",
);
