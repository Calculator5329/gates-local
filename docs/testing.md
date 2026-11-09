# Testing client ordering

`pnpm test` includes in-memory ordering replays for speech connection choices,
messages crossing a reconnect, and Stop pressed around a send acknowledgement.
They run two real client sessions against one scripted server, without a browser,
real socket, microphone or wall-clock waits. The production session and store
need no test seam. React supplies only non-rendering hooks for the speech buttons.

To add a scenario, describe what the person does, what the server can deliver,
and what must stay true. Add named events in
`apps/web/test/ordering-replay.test.ts`, with `after` constraints only where the
code requires an order, with a short source comment for every edge. Keep the
chosen button sequence separate from transport guarantees: it defines the input
story, not a rule about delivery. The scripted server
captures settings at the write and snapshots at the read, not at delivery.
Check the visible message, connection choice or intended reply after each event.

Settings broadcasts happen in `settings/handlers.ts` before the handler returns;
`ws/server.ts` awaits that return before sending the response. Schedule each
window's push independently. The sender's push precedes its response on its own
socket, while the other window may receive before or after either. Connect,
Disconnect and foreign theme saves all follow this rule. Both Connect deliveries
can happen while hydration is held. There is no dependency on hydration release.

Each producing event declares its emitted frames. The scheduler preserves FIFO
per socket, including across successive writes. Server completion and response
delivery are separate events for health checks and the held hydration request.
The speech scenarios start with A reconnected, a settings snapshot already
captured on the server, and hydration still in flight. That is their initial
condition, not exhaustive coverage of actions before that reconnect.

Chat admission stores the user row and broadcasts start before returning
(`app.ts`). Start therefore precedes the response on the sender's socket. Other
recipients are independent. A start is sent only to sockets open at admission;
it is never redirected to a replacement socket. Closed sockets drop their queued
frames. Stop and the following Send do not wait for acknowledgements, and two
chats' admissions may finish in either order.

Graphs with at most 64 legal orders are exhausted. Larger shipping scenarios
run 64 unique deterministic samples each: a DFS witness, witnesses that delay
each event in turn, then fixed-seed priority samples. The seven current product
scenarios all exceed 64 orders, so their 448 executed schedules are **not
exhaustive**. The reusable `schedules` utility still defaults to a 256-order
DFS prefix; `explore` selects the sampled policy used by `replay`. Both report
their coverage honestly and stop on the first invariant failure.
Bootstrap, preflight and unrelated sample RPCs settle between named events;
this explores the declared schedule, not every possible JavaScript task.
Reconnect advances a fake clock by 250 ms; request timeouts remain on that clock.
Skipped Connect saves retain no-op delivery slots so regression orders stay
complete; the coverage assertions require a successful save, not those no-ops.

SL-01 coverage assertions require a successful sender push then response before
hydration releases, both early and late delivery to the other window, and delivery
after hydration too. A cache-copy mutation that discarded an own Connect push
received during hydration passed all 72 old orders but failed on the first new
order. The production session was not changed. Separate assertions audit both
admission orders, late acknowledgements and admission before, during and after
the socket drop/reconnect.

A failure prints its completed prefix and the full JSON order. Paste its
`REPLAY_ORDER='[...]'` before this command to run just that regression:

```sh
pnpm exec vitest run apps/web/test/ordering-replay.test.ts -t 'speech preserves'
```

Use the matching test name. The pasted order is checked for missing events,
duplicates, broken causal constraints and socket FIFO violations. A new real bug stays as a named
`it.fails` case until its fix lands. Verify its failure is the named invariant;
an unavailable fixture or invalid schedule must not count as rediscovering a bug.
The scheduler also has a planted failing invariant to prove that checks fire and
the failing world is disposed.

Historical checks can select a cache copy of a real `session.ts` with
`REPLAY_SESSION`. Redirect only that copy's relative imports to the current
support modules; both the session and the speech buttons then use its real
exports and matching store instance. VE-01 was watched on `b7c653a`, VF-01 on
`e39ec41`, and LB-01 on `c8c8e3c`, with the same enumerated scenarios.
