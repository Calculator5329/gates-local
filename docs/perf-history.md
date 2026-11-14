# Performance history

One column per release, measured on the test machine with the priority journeys.
Times show the lower quartile of the repetitions. A count that was the same in
every run is exact and prints whole; ~ marks a count that varied between runs,
and shows its lower quartile to one decimal. A word beside a number means the
release measured differently from the build it was compared with; "not scored"
means it had too few repetitions to be tested at all. These numbers are
information, not a gate.

Limited-box readings from the performance nights of 2026-11-11 and 2026-11-12 include the synthetic GPU tool's cost and are not comparable with later readings that box only the app and browser.

Readings after the Linux shell GPU stand-in was introduced on 2026-11-13 use
that cheaper harness tool in both arms, even for older releases. Send rows may
step down because each fit check no longer starts Node; that is a harness
change, not an app speedup. Earlier columns retain their original readings.
The v0.1.0 to v0.2.3 columns were all measured with one fixed harness from
before both of these changes, so they compare with each other directly.

Refresh with `node test/perf/history.ts --label RELEASE --scored RESULTS/scored.json`.

## Time

| Action | main fb1684e | v0.1.0 | v0.2.0 | v0.2.1 | v0.2.2 | v0.2.3 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| cold-composer (ms) | 304 | 287 (not scored) | 125 (faster) | 136 | 139 | 131 |
| cold-composer.cpu-task (ms) | 233 | 230 (not scored) | 216 | 206 | 253 | 239 |
| thread-200-cold-click (ms) | 110 | 82.5 (not scored) | 81.3 | 81.0 | 82.9 | 78.4 |
| thread-200-cold-click.cpu-task (ms) | 109 | 81.1 (not scored) | 80.1 | 80.8 | 81.5 | 78.1 |
| thread-200-warm-click (ms) | 66.5 | 50.3 (not scored) | 46.4 | 44.8 | 47.2 | 46.9 |
| thread-200-warm-click.cpu-task (ms) | 73.8 | 48.9 (not scored) | 47.9 | 47.3 | 47.3 | 46.6 |
| thread-200-cold-hover (ms) | 78.5 | 45.9 (not scored) | 45.4 | 45.3 | 46.2 | 46.4 |
| thread-200-cold-hover.cpu-task (ms) | 80.6 | 50.0 (not scored) | 43.2 (faster) | 42.6 | 47.5 | 44.6 |
| thread-200-warm-hover (ms) | 64.6 | 46.8 (not scored) | 47.3 | 47.0 | 46.4 | 46.9 |
| thread-200-warm-hover.cpu-task (ms) | 68.7 | 49.6 (not scored) | 46.7 | 46.4 | 44.0 | 44.2 |
| thread-2000-cold-click (ms) | 556 | 106 (not scored) | 111 | 111 | 110 | 105 |
| thread-2000-cold-click.cpu-task (ms) | 559 | 83.1 (not scored) | 88.7 | 88.1 | 90.4 | 85.2 |
| thread-2000-warm-click (ms) | 430 | 45.7 (not scored) | 44.9 | 45.5 | 46.3 | 45.7 |
| thread-2000-warm-click.cpu-task (ms) | 460 | 48.7 (not scored) | 47.8 | 48.1 | 46.9 | 45.4 |
| thread-2000-cold-hover (ms) | 473 | 46.4 (not scored) | 47.6 (slower) | 46.9 | 46.8 | 48.3 |
| thread-2000-cold-hover.cpu-task (ms) | 480 | 46.6 (not scored) | 47.3 | 46.3 | 44.0 | 53.3 |
| thread-2000-warm-hover (ms) | 437 | 45.5 (not scored) | 49.7 | 46.5 | 46.9 | 46.4 |
| thread-2000-warm-hover.cpu-task (ms) | 465 | 43.9 (not scored) | 51.1 | 44.8 | 51.5 | 49.2 |
| open-huge-reply (ms) | 92.0 | 92.0 (not scored) | 91.6 | 91.3 | 91.0 | 92.0 |
| open-huge-reply.cpu-task (ms) | 73.7 | 74.7 (not scored) | 73.6 (faster) | 74.3 | 77.9 | 76.0 |
| copy-message (ms) | 57.6 | 59.1 (not scored) | 58.5 | 58.8 | 58.5 | 59.1 |
| copy-message.cpu-task (ms) | 16.0 | 16.4 (not scored) | 17.9 | 16.5 | 13.0 (faster) | 12.2 |
| copy-code-4000 (ms) | 58.9 | 59.3 (not scored) | 58.9 | 58.5 | 59.5 | 60.2 |
| copy-code-4000.cpu-task (ms) | 23.8 | 22.9 (not scored) | 24.8 | 24.7 | 22.1 | 21.0 |
| voice-start-recording (ms) | 60.2 |  |  | 60.5 | 60.2 | 60.5 |
| voice-start-recording.cpu-task (ms) | 23.6 |  |  | 19.9 | 15.2 (faster) | 15.7 |
| voice-stop-to-transcript (ms) | 59.1 |  |  | 59.0 | 59.3 | 59.4 |
| voice-stop-to-transcript.cpu-task (ms) | 26.9 |  |  | 29.9 (faster) | 23.8 | 21.7 |
| send-first-visible-token (ms) | 314 | 310 (not scored) | 312 | 327 | 362 | 331 |
| send-first-visible-token.cpu-task (ms) | 168 | 160 (not scored) | 173 (slower) | 163 | 183 | 164 |
| two-streams-start (ms) | 636 | 610 (not scored) | 642 (slower) | 626 | 642 | 642 |
| two-streams-start.cpu-task (ms) | 234 | 200 (not scored) | 217 (slower) | 217 | 218 | 203 |
| parallel-switch (ms) | 437 | 40.7 (not scored) | 39.7 | 39.8 | 39.4 | 39.4 |
| parallel-switch.cpu-task (ms) | 155 | 29.2 (not scored) | 29.6 | 30.4 | 32.4 | 30.1 |
| queue-send-1 (ms) | 38.1 | 40.2 (not scored) | 40.0 | 40.3 | 41.3 | 41.7 |
| queue-send-1.cpu-task (ms) | 22.7 | 20.2 (not scored) | 23.5 | 23.0 | 18.0 | 18.3 |
| queue-send-2 (ms) | 42.0 | 41.6 (not scored) | 41.0 | 41.9 | 41.8 | 42.3 |
| queue-send-2.cpu-task (ms) | 15.6 | 11.9 (not scored) | 13.1 | 18.9 | 14.0 (faster) | 16.8 |
| queue-send-3 (ms) | 43.4 | 42.9 (not scored) | 43.3 | 43.1 | 42.3 | 43.5 |
| queue-send-3.cpu-task (ms) | 11.9 | 12.2 (not scored) | 12.2 | 11.9 | 11.8 | 11.1 |
| queue-send-4 (ms) | 42.8 | 43.3 (not scored) | 41.4 | 42.9 | 43.2 | 43.0 |
| queue-send-4.cpu-task (ms) | 11.6 | 12.1 (not scored) | 11.8 | 12.1 | 11.9 | 11.4 |
| queue-send-5 (ms) | 43.5 | 43.3 (not scored) | 43.3 | 43.2 | 43.0 | 43.1 |
| queue-send-5.cpu-task (ms) | 12.0 | 12.2 (not scored) | 12.0 | 12.3 | 11.8 | 11.6 |
| queue-finish-to-next-token (ms) | 212 | 213 (not scored) | 218 | 219 | 218 | 227 |
| queue-finish-to-next-token.cpu-task (ms) | 177 | 166 (not scored) | 177 | 181 | 170 | 167 |
| reconnect-during-stream (ms) | 321 | 89.4 (not scored) | 79.1 | 84.0 | 86.0 | 89.6 |
| reconnect-during-stream.cpu-task (ms) | 145 | 78.5 (not scored) | 73.2 | 78.8 | 78.3 | 78.6 |
| thread-200-cold-click-mounted (ms) |  | 154 (not scored) | 127 (faster) | 126 | 126 | 126 |
| thread-200-cold-click-mounted.cpu-task (ms) |  | 128 (not scored) | 116 | 116 | 117 | 115 |
| thread-200-warm-click-mounted (ms) |  | 135 (not scored) | 110 (faster) | 103 | 103 | 91.3 |
| thread-200-warm-click-mounted.cpu-task (ms) |  | 111 (not scored) | 101 | 89.2 | 89.7 | 79.4 |
| thread-200-cold-hover-mounted (ms) |  | 110 (not scored) | 92.6 (faster) | 92.4 | 78.4 | 78.6 |
| thread-200-cold-hover-mounted.cpu-task (ms) |  | 89.7 (not scored) | 79.7 (faster) | 79.8 | 74.2 | 71.9 |
| thread-200-warm-hover-mounted (ms) |  | 111 (not scored) | 78.2 (faster) | 79.0 | 78.1 | 90.4 |
| thread-200-warm-hover-mounted.cpu-task (ms) |  | 89.6 (not scored) | 74.4 (faster) | 74.6 | 74.0 | 77.4 |
| thread-2000-cold-click-mounted (ms) |  | 1075 (not scored) | 607 (faster) | 624 | 607 | 587 |
| thread-2000-cold-click-mounted.cpu-task (ms) |  | 959 (not scored) | 564 (faster) | 574 | 557 | 545 |
| thread-2000-warm-click-mounted (ms) |  | 986 (not scored) | 524 (faster) | 524 | 520 | 492 |
| thread-2000-warm-click-mounted.cpu-task (ms) |  | 877 (not scored) | 500 (faster) | 508 | 491 | 472 |
| thread-2000-cold-hover-mounted (ms) |  | 993 (not scored) | 561 (faster) | 527 | 518 | 461 |
| thread-2000-cold-hover-mounted.cpu-task (ms) |  | 888 (not scored) | 525 (faster) | 504 | 493 | 454 |
| thread-2000-warm-hover-mounted (ms) |  | 952 (not scored) | 493 (faster) | 505 | 477 | 498 |
| thread-2000-warm-hover-mounted.cpu-task (ms) |  | 805 (not scored) | 453 (faster) | 470 | 466 | 479 |
| type-in-thread-2000 (ms) |  | 43.6 (not scored) | 43.9 | 43.2 | 43.5 | 43.4 |
| type-in-thread-2000.cpu-task (ms) |  | 18.6 (not scored) | 17.9 | 18.3 | 14.1 (faster) | 13.4 |

## Work

| Action | main fb1684e | v0.1.0 | v0.2.0 | v0.2.1 | v0.2.2 | v0.2.3 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| cold-composer.layouts (count) | ~7.0 | ~7.0 (not scored) | ~3.0 | ~2.8 | ~3.0 | ~3.0 |
| thread-200-cold-click.layouts (count) | 9 | ~12.0 (not scored) | ~11.0 | ~11.0 | ~11.0 | ~11.0 |
| thread-200-warm-click.layouts (count) | ~7.0 | ~8.8 (not scored) | ~6.0 (faster) | ~6.0 | ~6.8 | ~8.0 |
| thread-200-cold-hover.layouts (count) | 8 | ~9.0 (not scored) | ~7.0 (faster) | ~7.0 | ~7.0 | ~7.0 |
| thread-200-warm-hover.layouts (count) | ~6.0 | ~9.0 (not scored) | ~7.0 (faster) | ~7.0 | ~7.0 | ~7.0 |
| thread-2000-cold-click.layouts (count) | 9 | ~12.0 (not scored) | ~11.0 | ~11.0 | ~11.0 | ~10.8 |
| thread-2000-warm-click.layouts (count) | 7 | ~9.0 (not scored) | ~8.0 (faster) | ~8.0 | ~7.8 | ~7.8 |
| thread-2000-cold-hover.layouts (count) | 8 | ~8.0 (not scored) | ~7.0 | ~7.0 | ~7.0 | ~8.0 |
| thread-2000-warm-hover.layouts (count) | 6 | ~8.0 (not scored) | ~7.0 | ~7.0 | ~7.0 | ~7.0 |
| open-huge-reply.layouts (count) | 4 | 5 (not scored) | 4 (faster) | 4 | 4 | 4 |
| copy-message.layouts (count) | ~2.0 | 3 (not scored) | 3 | 3 | ~3.0 | 3 |
| copy-code-4000.layouts (count) | ~3.0 | ~3.0 (not scored) | ~3.0 | ~3.0 (faster) | ~3.0 | ~3.0 |
| voice-start-recording.layouts (count) | 2 |  |  | 2 | 2 | 2 |
| voice-stop-to-transcript.layouts (count) | ~5.0 |  |  | 11 | 11 | 11 |
| send-first-visible-token.layouts (count) | ~12.0 | ~11.0 (not scored) | ~9.8 | ~10.8 | ~10.0 | ~10.0 |
| two-streams-start.layouts (count) | ~20.0 | ~22.0 (not scored) | ~21.0 | ~18.8 | ~19.0 | ~19.0 |
| parallel-switch.layouts (count) | ~29.2 | ~3.8 (not scored) | ~2.8 (faster) | ~2.9 | ~3.3 | ~2.9 |
| queue-send-1.layouts (count) | ~4.8 | ~4.0 (not scored) | ~4.0 | ~4.0 | ~3.8 | ~4.0 |
| queue-send-2.layouts (count) | ~3.8 | ~2.0 (not scored) | ~1.8 | ~3.0 | ~2.8 | ~3.8 |
| queue-send-3.layouts (count) | 2 | 2 (not scored) | 1 (faster) | 1 | 1 | 1 |
| queue-send-4.layouts (count) | 2 | 2 (not scored) | 1 (faster) | 1 | 1 | 1 |
| queue-send-5.layouts (count) | 2 | 2 (not scored) | 1 (faster) | 1 | 1 | 1 |
| queue-finish-to-next-token.layouts (count) | ~15.0 | ~14.8 (not scored) | ~14.8 | ~15.8 | ~15.0 | ~14.0 |
| reconnect-during-stream.layouts (count) | ~18.0 | ~9.5 (not scored) | ~15.8 | ~11.8 | ~15.0 | ~5.0 (faster) |
| cold-composer.react-commits (count) | ~9.0 | ~8.0 (not scored) | ~7.0 | ~8.0 | ~8.0 | ~8.0 |
| cold-composer.react-renders (count) | ~1458.0 | ~1264.0 (not scored) | ~569.8 (faster) | ~566.0 | ~568.8 | ~589.0 |
| cold-composer.requests (count) | ~4.0 | ~4.0 (not scored) | ~3.0 | ~4.5 | ~5.0 | ~5.0 |
| cold-composer.bytes (count) | ~181164.0 | ~185721.0 (not scored) | ~168618.0 | ~169603.0 | ~175125.0 | ~179701.0 (slower) |
| cold-composer.ws-in (count) | ~16.0 | ~16.0 (not scored) | ~16.0 | ~17.5 | ~19.0 | ~18.5 |
| cold-composer.dom-elements (count) | ~3569.0 | ~3569.0 (not scored) | ~3600.0 | ~3600.0 | ~3594.0 | ~3621.0 |
| thread-200-cold-click.react-commits (count) | 2 | ~4.8 (not scored) | ~3.8 | ~4.0 | ~4.0 | ~3.0 |
| thread-200-cold-click.react-renders (count) | 2060 | ~1741.0 (not scored) | ~1921.0 | ~2175.0 | ~2175.0 | ~1171.8 |
| thread-200-cold-click.requests (count) | 0 | 0 (not scored) | 0 | 0 | 0 | 0 |
| thread-200-cold-click.bytes (count) | 0 | 0 (not scored) | 0 | 0 | 0 | 0 |
| thread-200-cold-click.ws-in (count) | 1 | 1 (not scored) | 1 | 1 | 1 | 1 |
| thread-200-cold-click.dom-elements (count) | 6854 | ~6039.0 (not scored) | ~6400.0 | ~6885.0 | ~4975.0 | ~4962.0 |
| thread-200-warm-click.react-commits (count) | 1 | ~2.0 (not scored) | ~2.0 | ~2.0 | ~3.0 | ~3.0 |
| thread-200-warm-click.react-renders (count) | 2059 | ~1150.8 (not scored) | ~1155.8 | ~1155.8 | ~2173.0 | ~2182.0 |
| thread-200-warm-click.requests (count) | 0 | 0 (not scored) | 0 | 0 | 0 | 0 |
| thread-200-warm-click.bytes (count) | 0 | 0 (not scored) | 0 | 0 | 0 | 0 |
| thread-200-warm-click.ws-in (count) | 0 | 0 (not scored) | 0 | 0 | 0 | 0 |
| thread-200-warm-click.dom-elements (count) | 6854 | ~4904.0 (not scored) | ~4905.0 | ~4905.0 | ~4975.0 | ~4972.0 |
| thread-200-cold-hover.react-commits (count) | 2 | ~3.0 (not scored) | ~3.0 | 3 | ~3.0 | ~3.0 |
| thread-200-cold-hover.react-renders (count) | 2060 | ~1483.0 (not scored) | ~2173.0 (slower) | 2178 | ~2173.0 | ~2182.0 |
| thread-200-cold-hover.requests (count) | 0 | 0 (not scored) | 0 | 0 | 0 | 0 |
| thread-200-cold-hover.bytes (count) | 0 | 0 (not scored) | 0 | 0 | 0 | 0 |
| thread-200-cold-hover.ws-in (count) | 1 | 0 (not scored) | 0 | 0 | 0 | 0 |
| thread-200-cold-hover.dom-elements (count) | 6854 | ~5389.0 (not scored) | ~6885.0 (slower) | 6925 | ~6885.0 | ~6912.0 |
| thread-200-warm-hover.react-commits (count) | 1 | 3 (not scored) | 3 | ~3.0 | ~3.0 | ~3.0 |
| thread-200-warm-hover.react-renders (count) | 2059 | 1488 (not scored) | 2178 (slower) | ~2173.0 | ~2173.0 | ~2182.0 |
| thread-200-warm-hover.requests (count) | 0 | 0 (not scored) | 0 | 0 | 0 | 0 |
| thread-200-warm-hover.bytes (count) | 0 | 0 (not scored) | 0 | 0 | 0 | 0 |
| thread-200-warm-hover.ws-in (count) | 0 | 0 (not scored) | 0 | 0 | 0 | 0 |
| thread-200-warm-hover.dom-elements (count) | 6854 | ~5534.0 (not scored) | ~6885.0 (slower) | ~6885.0 | ~6885.0 | ~5002.0 |
| thread-2000-cold-click.react-commits (count) | 2 | ~4.0 (not scored) | ~4.0 | ~4.0 | ~4.0 | ~4.0 |
| thread-2000-cold-click.react-renders (count) | 16460 | ~1487.8 (not scored) | ~2175.0 (slower) | ~2180.0 | ~2175.0 | ~2187.8 |
| thread-2000-cold-click.requests (count) | 0 | 0 (not scored) | 0 | 0 | 0 | 0 |
| thread-2000-cold-click.bytes (count) | 0 | 0 (not scored) | 0 | 0 | 0 | 0 |
| thread-2000-cold-click.ws-in (count) | 1 | 1 (not scored) | 1 | 1 | 1 | 1 |
| thread-2000-cold-click.dom-elements (count) | 36554 | ~5564.0 (not scored) | ~6885.0 (slower) | 6925 | ~6885.0 | ~6912.0 |
| thread-2000-warm-click.react-commits (count) | 1 | ~3.0 (not scored) | ~2.8 | ~3.0 | ~3.0 | ~3.0 |
| thread-2000-warm-click.react-renders (count) | 16459 | ~1491.8 (not scored) | ~1920.3 | ~2173.0 | ~2173.0 | ~2182.0 |
| thread-2000-warm-click.requests (count) | 0 | 0 (not scored) | 0 | 0 | 0 | 0 |
| thread-2000-warm-click.bytes (count) | 0 | 0 (not scored) | 0 | 0 | 0 | 0 |
| thread-2000-warm-click.ws-in (count) | 0 | 0 (not scored) | 0 | 0 | 0 | 0 |
| thread-2000-warm-click.dom-elements (count) | 36554 | ~5534.0 (not scored) | ~6410.0 (slower) | ~6885.0 | ~4985.0 | ~6437.0 |
| thread-2000-cold-hover.react-commits (count) | 2 | ~3.0 (not scored) | ~3.0 | ~3.8 | ~3.0 | ~4.0 |
| thread-2000-cold-hover.react-renders (count) | 16460 | ~1483.0 (not scored) | ~2178.0 (slower) | ~2941.3 | ~2178.0 | ~3203.0 |
| thread-2000-cold-hover.requests (count) | 0 | 0 (not scored) | 0 | 0 | 0 | 0 |
| thread-2000-cold-hover.bytes (count) | 0 | 0 (not scored) | 0 | 0 | 0 | 0 |
| thread-2000-cold-hover.ws-in (count) | 1 | 0 (not scored) | 0 | 0 | 0 | 0 |
| thread-2000-cold-hover.dom-elements (count) | 36554 | ~5534.0 (not scored) | ~6885.0 (slower) | ~6885.0 | ~6885.0 | ~6912.0 |
| thread-2000-warm-hover.react-commits (count) | 1 | ~3.0 (not scored) | ~2.8 | ~2.8 | ~2.8 | ~4.0 |
| thread-2000-warm-hover.react-renders (count) | 16459 | ~1486.8 (not scored) | ~1924.0 (slower) | ~1920.3 | ~1920.3 | ~3203.0 |
| thread-2000-warm-hover.requests (count) | 0 | 0 (not scored) | 0 | 0 | 0 | 0 |
| thread-2000-warm-hover.bytes (count) | 0 | 0 (not scored) | 0 | 0 | 0 | 0 |
| thread-2000-warm-hover.ws-in (count) | 0 | 0 (not scored) | 0 | 0 | 0 | 0 |
| thread-2000-warm-hover.dom-elements (count) | 36554 | ~5564.0 (not scored) | ~4985.0 | ~4935.0 | ~4935.0 | ~6912.0 |
| open-huge-reply.react-commits (count) | 2 | 2 (not scored) | 2 | 2 | 2 | 2 |
| open-huge-reply.react-renders (count) | 473 | 481 (not scored) | 492 (slower) | 492 | 492 | 501 (slower) |
| open-huge-reply.requests (count) | 0 | 0 (not scored) | 0 | 0 | 0 | 0 |
| open-huge-reply.bytes (count) | 0 | 0 (not scored) | 0 | 0 | 0 | 0 |
| open-huge-reply.ws-in (count) | 1 | 1 (not scored) | 1 | 1 | 1 | 1 |
| open-huge-reply.dom-elements (count) | 4480 | 4520 (not scored) | 4551 (slower) | 4551 | 4551 | 4578 (slower) |
| copy-message.react-commits (count) | 2 | 2 (not scored) | 2 | 2 | 2 | 2 |
| copy-message.react-renders (count) | 2 | 2 (not scored) | 2 | 2 | 2 | 2 |
| copy-message.requests (count) | 0 | 0 (not scored) | 0 | 0 | 0 | 0 |
| copy-message.bytes (count) | 0 | 0 (not scored) | 0 | 0 | 0 | 0 |
| copy-message.ws-in (count) | 0 | 0 (not scored) | 0 | 0 | 0 | 0 |
| copy-message.dom-elements (count) | 3562 | 3602 (not scored) | 3633 (slower) | 3633 | 3633 | 3660 (slower) |
| copy-code-4000.react-commits (count) | 2 | 2 (not scored) | 2 | 2 | 2 | 2 |
| copy-code-4000.react-renders (count) | 2 | 2 (not scored) | 2 | 2 | 2 | 2 |
| copy-code-4000.requests (count) | 0 | 0 (not scored) | 0 | 0 | 0 | 0 |
| copy-code-4000.bytes (count) | 0 | 0 (not scored) | 0 | 0 | 0 | 0 |
| copy-code-4000.ws-in (count) | 0 | 0 (not scored) | 0 | 0 | 0 | 0 |
| copy-code-4000.dom-elements (count) | 4481 | 4521 (not scored) | 4552 (slower) | 4552 | 4552 | 4579 (slower) |
| voice-start-recording.react-commits (count) | 2 |  |  | 2 | 2 | 2 |
| voice-start-recording.react-renders (count) | 2 |  |  | 2 | 2 | 2 |
| voice-start-recording.requests (count) | 0 |  |  | 0 | 0 | 0 |
| voice-start-recording.bytes (count) | 0 |  |  | 0 | 0 | 0 |
| voice-start-recording.ws-in (count) | 0 |  |  | 0 | 0 | 0 |
| voice-start-recording.dom-elements (count) | 3569 |  |  | 3640 | 3634 (faster) | 3663 (slower) |
| voice-stop-to-transcript.react-commits (count) | 3 |  |  | 3 | 3 | 3 |
| voice-stop-to-transcript.react-renders (count) | 17 |  |  | 21 | 21 | 22 (slower) |
| voice-stop-to-transcript.requests (count) | 0 |  |  | 0 | 0 | 0 |
| voice-stop-to-transcript.bytes (count) | 0 |  |  | 0 | 0 | 0 |
| voice-stop-to-transcript.ws-in (count) | 1 |  |  | 1 | 1 | 1 |
| voice-stop-to-transcript.dom-elements (count) | 3569 |  |  | 3640 | 3634 (faster) | 3663 (slower) |
| send-first-visible-token.react-commits (count) | ~17.8 | ~15.8 (not scored) | ~15.0 | ~16.0 | ~15.0 | ~15.0 |
| send-first-visible-token.react-renders (count) | ~2516.3 | ~1719.5 (not scored) | ~1835.3 | ~1836.0 | ~3073.8 (slower) | ~2994.3 |
| send-first-visible-token.requests (count) | 0 | 0 (not scored) | 0 | 0 | 0 | 0 |
| send-first-visible-token.bytes (count) | 0 | 0 (not scored) | 0 | 0 | 0 | 0 |
| send-first-visible-token.ws-in (count) | ~104.5 | ~103.8 (not scored) | ~105.0 | ~105.0 | ~107.0 | ~104.8 |
| send-first-visible-token.dom-elements (count) | ~3580.8 | ~3586.0 (not scored) | ~3617.8 | ~3618.0 | ~3624.0 | ~3651.0 |
| two-streams-start.react-commits (count) | ~21.0 | ~20.0 (not scored) | ~20.0 | ~20.0 | ~20.0 | ~20.0 |
| two-streams-start.react-renders (count) | ~2188.0 | ~1383.0 (not scored) | ~1394.0 | ~1397.0 | ~2637.5 (slower) | ~2659.5 |
| two-streams-start.requests (count) | 0 | 0 (not scored) | 0 | 0 | 0 | 0 |
| two-streams-start.bytes (count) | 0 | 0 (not scored) | 0 | 0 | 0 | 0 |
| two-streams-start.ws-in (count) | ~45.0 | ~44.0 (not scored) | ~44.0 | ~44.0 | ~45.0 | ~45.0 |
| two-streams-start.dom-elements (count) | 3592 | 3632 (not scored) | 3661 (slower) | 3661 | 3661 | 3689 (slower) |
| parallel-switch.react-commits (count) | ~26.6 | ~2.4 (not scored) | ~2.0 (faster) | ~2.0 | ~2.0 | ~2.3 |
| parallel-switch.react-renders (count) | ~542.9 | ~476.1 (not scored) | ~484.0 (slower) | ~483.8 | ~485.8 | ~498.4 (slower) |
| parallel-switch.requests (count) | 0 | 0 (not scored) | 0 | 0 | 0 | 0 |
| parallel-switch.bytes (count) | 0 | 0 (not scored) | 0 | 0 | 0 | 0 |
| parallel-switch.ws-in (count) | ~37.2 | ~5.0 (not scored) | ~4.7 | ~5.0 | ~5.0 | ~5.6 |
| parallel-switch.dom-elements (count) | 3592 | 3632 (not scored) | 3661 (slower) | 3661 | 3661 | 3689 (slower) |
| queue-send-1.react-commits (count) | ~3.8 | ~3.0 (not scored) | ~3.0 | ~3.0 | ~3.0 | ~1.0 |
| queue-send-1.react-renders (count) | ~23.3 | ~24.0 (not scored) | ~25.0 | ~25.0 | ~30.3 (slower) | ~21.0 |
| queue-send-1.requests (count) | 0 | 0 (not scored) | 0 | 0 | 0 | 0 |
| queue-send-1.bytes (count) | 0 | 0 (not scored) | 0 | 0 | 0 | 0 |
| queue-send-1.ws-in (count) | ~0.0 | 0 (not scored) | 0 | 0 | ~0.0 | 0 |
| queue-send-1.dom-elements (count) | ~3614.0 | ~3620.0 (not scored) | ~3649.0 | ~3649.0 | ~3650.0 | ~3684.0 |
| queue-send-2.react-commits (count) | ~2.0 | ~2.0 (not scored) | ~1.8 | ~1.8 | ~1.8 | ~1.0 |
| queue-send-2.react-renders (count) | ~16.0 | ~23.0 (not scored) | ~22.5 | ~22.5 | ~28.5 | ~25.0 |
| queue-send-2.requests (count) | 0 | 0 (not scored) | 0 | 0 | 0 | 0 |
| queue-send-2.bytes (count) | 0 | 0 (not scored) | 0 | 0 | 0 | 0 |
| queue-send-2.ws-in (count) | 0 | 0 (not scored) | 0 | 0 | 0 | 0 |
| queue-send-2.dom-elements (count) | 3630 | 3670 (not scored) | 3699 (slower) | 3699 | ~3673.0 | ~3701.0 |
| queue-send-3.react-commits (count) | 2 | 1 (not scored) | 1 | 1 | 1 | 1 |
| queue-send-3.react-renders (count) | 17 | 18 (not scored) | 19 (slower) | 19 | 28 (slower) | 29 (slower) |
| queue-send-3.requests (count) | 0 | 0 (not scored) | 0 | 0 | 0 | 0 |
| queue-send-3.bytes (count) | 0 | 0 (not scored) | 0 | 0 | 0 | 0 |
| queue-send-3.ws-in (count) | 0 | 0 (not scored) | 0 | 0 | 0 | 0 |
| queue-send-3.dom-elements (count) | 3638 | 3678 (not scored) | 3707 (slower) | 3707 | 3728 (slower) | 3756 (slower) |
| queue-send-4.react-commits (count) | 2 | 1 (not scored) | 1 | 1 | 1 | 1 |
| queue-send-4.react-renders (count) | 18 | 19 (not scored) | 20 (slower) | 20 | 32 (slower) | 33 (slower) |
| queue-send-4.requests (count) | 0 | 0 (not scored) | 0 | 0 | 0 | 0 |
| queue-send-4.bytes (count) | 0 | 0 (not scored) | 0 | 0 | 0 | 0 |
| queue-send-4.ws-in (count) | 0 | 0 (not scored) | 0 | 0 | 0 | 0 |
| queue-send-4.dom-elements (count) | 3646 | 3686 (not scored) | 3715 (slower) | 3715 | 3743 (slower) | 3771 (slower) |
| queue-send-5.react-commits (count) | 2 | 1 (not scored) | 1 | 1 | 1 | 1 |
| queue-send-5.react-renders (count) | 19 | 20 (not scored) | 21 (slower) | 21 | 36 (slower) | 37 (slower) |
| queue-send-5.requests (count) | 0 | 0 (not scored) | 0 | 0 | 0 | 0 |
| queue-send-5.bytes (count) | 0 | 0 (not scored) | 0 | 0 | 0 | 0 |
| queue-send-5.ws-in (count) | 0 | 0 (not scored) | 0 | 0 | 0 | 0 |
| queue-send-5.dom-elements (count) | 3654 | 3694 (not scored) | 3723 (slower) | 3723 | 3758 (slower) | 3786 (slower) |
| queue-finish-to-next-token.react-commits (count) | ~22.0 | ~21.0 (not scored) | ~21.0 | ~20.8 | ~21.0 | ~19.8 |
| queue-finish-to-next-token.react-renders (count) | ~2637.0 | ~1845.0 (not scored) | ~1421.3 | ~1409.8 | ~2711.5 (slower) | ~2706.0 |
| queue-finish-to-next-token.requests (count) | 0 | 0 (not scored) | 0 | 0 | 0 | 0 |
| queue-finish-to-next-token.bytes (count) | 0 | 0 (not scored) | 0 | 0 | 0 | 0 |
| queue-finish-to-next-token.ws-in (count) | ~150.0 | ~149.0 (not scored) | ~151.0 (slower) | ~151.8 | ~151.8 | ~152.0 |
| queue-finish-to-next-token.dom-elements (count) | ~3700.8 | ~3701.0 (not scored) | ~3721.0 | ~3721.0 | ~3755.8 | ~3777.0 |
| reconnect-during-stream.react-commits (count) | ~15.0 | ~10.0 (not scored) | ~12.8 (slower) | ~12.0 | ~12.0 | ~12.0 |
| reconnect-during-stream.react-renders (count) | ~978.5 | ~943.0 (not scored) | ~971.8 (slower) | ~1430.5 (slower) | ~1845.0 (slower) | ~1868.0 (slower) |
| reconnect-during-stream.requests (count) | 0 | 0 (not scored) | 0 | 0 | 0 | 0 |
| reconnect-during-stream.bytes (count) | 0 | 0 (not scored) | 0 | 0 | 0 | 0 |
| reconnect-during-stream.ws-in (count) | ~98.3 | ~99.5 (not scored) | ~94.8 | ~104.0 | ~105.0 | ~96.0 |
| reconnect-during-stream.dom-elements (count) | ~3645.8 | ~3611.5 (not scored) | ~3640.5 | ~3638.0 | ~3641.8 | ~3667.0 |
| thread-200-cold-click-mounted.layouts (count) |  | ~18.8 (not scored) | ~15.0 (faster) | ~14.8 | ~14.0 | ~15.0 |
| thread-200-warm-click-mounted.layouts (count) |  | ~17.0 (not scored) | ~12.0 | ~12.0 | ~12.0 | ~12.0 |
| thread-200-cold-hover-mounted.layouts (count) |  | ~15.0 (not scored) | ~11.0 | ~11.0 | ~10.0 | ~10.0 |
| thread-200-warm-hover-mounted.layouts (count) |  | ~15.0 (not scored) | ~10.0 | ~10.0 | ~10.0 | ~10.8 |
| thread-2000-cold-click-mounted.layouts (count) |  | 70 (not scored) | 37 (faster) | 37 | ~37.0 | 37 |
| thread-2000-warm-click-mounted.layouts (count) |  | 67 (not scored) | 34 (faster) | 34 | ~33.8 | ~34.0 |
| thread-2000-cold-hover-mounted.layouts (count) |  | 66 (not scored) | 33 (faster) | ~33.0 | 33 | 33 |
| thread-2000-warm-hover-mounted.layouts (count) |  | 66 (not scored) | 33 (faster) | ~33.0 | 33 | 33 |
| type-in-thread-2000.layouts (count) |  | 4 (not scored) | 2 (faster) | 2 | 2 | 2 |
| thread-200-cold-click-mounted.react-commits (count) |  | 6 (not scored) | 4 (faster) | 4 | 4 | 4 |
| thread-200-cold-click-mounted.react-renders (count) |  | 2171 (not scored) | 2180 (slower) | 2180 | 2180 | 2189 (slower) |
| thread-200-cold-click-mounted.requests (count) |  | 0 (not scored) | 0 | 0 | 0 | 0 |
| thread-200-cold-click-mounted.bytes (count) |  | 0 (not scored) | 0 | 0 | 0 | 0 |
| thread-200-cold-click-mounted.ws-in (count) |  | 1 (not scored) | 1 | 1 | 1 | 1 |
| thread-200-cold-click-mounted.dom-elements (count) |  | 6894 (not scored) | 6925 (slower) | 6925 | 6925 | 6952 (slower) |
| thread-200-warm-click-mounted.react-commits (count) |  | 5 (not scored) | 3 (faster) | 3 | 3 | 3 |
| thread-200-warm-click-mounted.react-renders (count) |  | 2170 (not scored) | 2178 (slower) | 2178 | 2178 | 2187 (slower) |
| thread-200-warm-click-mounted.requests (count) |  | 0 (not scored) | 0 | 0 | 0 | 0 |
| thread-200-warm-click-mounted.bytes (count) |  | 0 (not scored) | 0 | 0 | 0 | 0 |
| thread-200-warm-click-mounted.ws-in (count) |  | 0 (not scored) | 0 | 0 | 0 | 0 |
| thread-200-warm-click-mounted.dom-elements (count) |  | 6894 (not scored) | 6925 (slower) | 6925 | 6925 | 6952 (slower) |
| thread-200-cold-hover-mounted.react-commits (count) |  | 5 (not scored) | 3 (faster) | 3 | 3 | 3 |
| thread-200-cold-hover-mounted.react-renders (count) |  | 2170 (not scored) | 2178 (slower) | 2178 | 2178 | 2187 (slower) |
| thread-200-cold-hover-mounted.requests (count) |  | 0 (not scored) | 0 | 0 | 0 | 0 |
| thread-200-cold-hover-mounted.bytes (count) |  | 0 (not scored) | 0 | 0 | 0 | 0 |
| thread-200-cold-hover-mounted.ws-in (count) |  | 0 (not scored) | 0 | 0 | 0 | 0 |
| thread-200-cold-hover-mounted.dom-elements (count) |  | 6894 (not scored) | 6925 (slower) | 6925 | 6925 | 6952 (slower) |
| thread-200-warm-hover-mounted.react-commits (count) |  | 5 (not scored) | 3 (faster) | 3 | 3 | 3 |
| thread-200-warm-hover-mounted.react-renders (count) |  | 2170 (not scored) | 2178 (slower) | 2178 | 2178 | 2187 (slower) |
| thread-200-warm-hover-mounted.requests (count) |  | 0 (not scored) | 0 | 0 | 0 | 0 |
| thread-200-warm-hover-mounted.bytes (count) |  | 0 (not scored) | 0 | 0 | 0 | 0 |
| thread-200-warm-hover-mounted.ws-in (count) |  | 0 (not scored) | 0 | 0 | 0 | 0 |
| thread-200-warm-hover-mounted.dom-elements (count) |  | 6894 (not scored) | 6925 (slower) | 6925 | 6925 | 6952 (slower) |
| thread-2000-cold-click-mounted.react-commits (count) |  | 51 (not scored) | 19 (faster) | 19 | 19 | 19 |
| thread-2000-cold-click-mounted.react-renders (count) |  | 17516 (not scored) | 17495 (faster) | 17495 | 17495 | 17504 (slower) |
| thread-2000-cold-click-mounted.requests (count) |  | 0 (not scored) | 0 | 0 | 0 | 0 |
| thread-2000-cold-click-mounted.bytes (count) |  | 0 (not scored) | 0 | 0 | 0 | 0 |
| thread-2000-cold-click-mounted.ws-in (count) |  | 1 (not scored) | 1 | 1 | 1 | 1 |
| thread-2000-cold-click-mounted.dom-elements (count) |  | 36594 (not scored) | 36625 (slower) | 36625 | 36625 | 36652 (slower) |
| thread-2000-warm-click-mounted.react-commits (count) |  | 50 (not scored) | 18 (faster) | 18 | 18 | 18 |
| thread-2000-warm-click-mounted.react-renders (count) |  | 17515 (not scored) | 17493 (faster) | 17493 | 17493 | 17502 (slower) |
| thread-2000-warm-click-mounted.requests (count) |  | 0 (not scored) | 0 | 0 | 0 | 0 |
| thread-2000-warm-click-mounted.bytes (count) |  | 0 (not scored) | 0 | 0 | 0 | 0 |
| thread-2000-warm-click-mounted.ws-in (count) |  | 0 (not scored) | 0 | 0 | 0 | 0 |
| thread-2000-warm-click-mounted.dom-elements (count) |  | 36594 (not scored) | 36625 (slower) | 36625 | 36625 | 36652 (slower) |
| thread-2000-cold-hover-mounted.react-commits (count) |  | 50 (not scored) | 18 (faster) | 18 | 18 | 18 |
| thread-2000-cold-hover-mounted.react-renders (count) |  | 17515 (not scored) | 17493 (faster) | 17493 | 17493 | 17502 (slower) |
| thread-2000-cold-hover-mounted.requests (count) |  | 0 (not scored) | 0 | 0 | 0 | 0 |
| thread-2000-cold-hover-mounted.bytes (count) |  | 0 (not scored) | 0 | 0 | 0 | 0 |
| thread-2000-cold-hover-mounted.ws-in (count) |  | 0 (not scored) | 0 | 0 | 0 | 0 |
| thread-2000-cold-hover-mounted.dom-elements (count) |  | 36594 (not scored) | 36625 (slower) | 36625 | 36625 | 36652 (slower) |
| thread-2000-warm-hover-mounted.react-commits (count) |  | 50 (not scored) | 18 (faster) | 18 | 18 | 18 |
| thread-2000-warm-hover-mounted.react-renders (count) |  | 17515 (not scored) | 17493 (faster) | 17493 | 17493 | 17502 (slower) |
| thread-2000-warm-hover-mounted.requests (count) |  | 0 (not scored) | 0 | 0 | 0 | 0 |
| thread-2000-warm-hover-mounted.bytes (count) |  | 0 (not scored) | 0 | 0 | 0 | 0 |
| thread-2000-warm-hover-mounted.ws-in (count) |  | 0 (not scored) | 0 | 0 | 0 | 0 |
| thread-2000-warm-hover-mounted.dom-elements (count) |  | 36594 (not scored) | 36625 (slower) | 36625 | 36625 | 36652 (slower) |
| type-in-thread-2000.react-commits (count) |  | 1 (not scored) | 1 | 1 | 1 | 1 |
| type-in-thread-2000.react-renders (count) |  | 16 (not scored) | 17 (slower) | 17 | 17 | 18 (slower) |
| type-in-thread-2000.requests (count) |  | 0 (not scored) | 0 | 0 | 0 | 0 |
| type-in-thread-2000.bytes (count) |  | 0 (not scored) | 0 | 0 | 0 | 0 |
| type-in-thread-2000.ws-in (count) |  | 0 (not scored) | 0 | 0 | 0 | 0 |
| type-in-thread-2000.dom-elements (count) |  | 36594 (not scored) | 36625 (slower) | 36625 | 36625 | 36652 (slower) |
