# Testing client ordering

`pnpm test` includes in-memory ordering replays for speech connection choices,
messages crossing a reconnect, and Stop pressed around a send acknowledgement.
They run two real client sessions against one scripted server, without a browser,
real socket, microphone or wall-clock waits. The production session and store
need no test seam. React supplies only non-rendering hooks for the speech buttons.

To add a scenario, describe what the person does, what the server can deliver,
and what must stay true. Add named events in
`apps/web/test/ordering-replay.test.ts`, with `after` constraints only where the
product requires an order: a response follows its request, a push follows its
write, and successive pushes on one socket retain their order. Keep independent
windows' actions and hydration release free to interleave. The scripted server
captures settings at the write and snapshots at the read, not at delivery.
Check the visible message, connection choice or intended reply after each event.

The scheduler enumerates topological sorts deterministically, stopping on the
first failure. All shipping scenarios require exhaustive coverage within 1,024
orders. The reusable scheduler defaults to 256 orders; above its limit it
reports a bounded DFS prefix, never exhaustive coverage. Split larger scenarios
by user intent or phase instead of raising the test cost without a bound.
Bootstrap, preflight and unrelated sample RPCs settle between named events;
this explores the declared schedule, not every possible JavaScript task.
Reconnect advances a fake clock by 250 ms; request timeouts remain on that clock.

A failure prints its completed prefix and the full JSON order. Paste its
`REPLAY_ORDER='[...]'` before this command to run just that regression:

```sh
pnpm exec vitest run apps/web/test/ordering-replay.test.ts -t 'speech preserves'
```

Use the matching test name. The pasted order is checked for missing events,
duplicates and broken causal constraints. A new real bug stays as a named
`it.fails` case until its fix lands. Verify its failure is the named invariant;
an unavailable fixture or invalid schedule must not count as rediscovering a bug.
The scheduler also has a planted failing invariant to prove that checks fire and
the failing world is disposed.

Historical checks can select a cache copy of a real `session.ts` with
`REPLAY_SESSION`. Redirect only that copy's relative imports to the current
support modules; both the session and the speech buttons then use its real
exports and matching store instance. VE-01 was watched on `b7c653a`, VF-01 on
`e39ec41`, and LB-01 on `c8c8e3c`, with the same enumerated scenarios.
