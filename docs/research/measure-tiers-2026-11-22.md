# Measure 6 on the tier candidates, 2026-11-22

Roadmap item `work:e21cf626`. Each candidate ran `pnpm measure:compare <model> --variant default`
and `--variant shell-only` once, with `--ctx 16384`, on the maintainer's desktop (16 GB card), one
model loaded at a time. The JSON for each run stays on that machine under
`~/.cache/gates-local-measure-compare/tier-20261122/`. Pages are not part of the headless run.

**Not as planned:** the plan asked for the Linux test machine with nothing else loaded. These runs
used the maintainer's desktop with its speech server holding 2.0 GiB of the card throughout (3.3
GiB in use before each model loaded). Scores are unaffected; gpt-oss:20b's speed is not clean (see
below). One run per cell: one check is worth 3 to 7 points, so a gap of one check is within noise.

## Score per part

| model | harness | score | tools | files | database | instructions | images | tok/s | s |
|---|---|---|---|---|---|---|---|---|---|
| qwen3.5:4b | default | 86 | 4/5 | 3/5 | 6/6 | 5/5 | 3/3 | 181 | 131 |
| qwen3.5:4b | shell-only | 95 | 4/5 | 5/5 | 6/6 | 5/5 | 3/3 | 184 | 64 |
| qwen3.5:9b | default | 100 | 5/5 | 5/5 | 6/6 | 5/5 | 3/3 | 123 | 100 |
| qwen3.5:9b | shell-only | 100 | 5/5 | 5/5 | 6/6 | 5/5 | 3/3 | 123 | 96 |
| gemma4:12b | default | 95 | 5/5 | 4/5 | 6/6 | 5/5 | 3/3 | 187 | 114 |
| gemma4:12b | shell-only | 95 | 5/5 | 4/5 | 6/6 | 5/5 | 3/3 | 211 | 64 |
| gpt-oss:20b | default | 81 | 3/5 | 3/5 | 6/6 | 5/5 | 3/3 | 84 | 147 |
| gpt-oss:20b | shell-only | 95 | 5/5 | 4/5 | 6/6 | 5/5 | 3/3 | 84 | 125 |
| huihui_ai/gemma-4-abliterated:12b | default | 65 | 3/5 | 3/5 | 3/6 | 5/5 | 2/3 | 89 | 194 |
| huihui_ai/gemma-4-abliterated:12b | shell-only | 61 | 3/5 | 2/5 | 3/6 | 5/5 | 2/3 | 90 | 198 |

Inkling 2 Mini (bridge, IQ3_S) did not load in either variant: the bridge's llama-server could not
create a 16k context next to the speech server. Not retried.

Checks missed:

- qwen3.5:4b: default tools-chain, files-needle and files-sum (no answer); shell-only tools-count.
- gemma4:12b: default files-sum; shell-only files-nested.
- gpt-oss:20b: default tools-recover, tools-chain (never queried the database), files-needle,
  files-nested; shell-only files-nested.
- huihui_ai/gemma-4-abliterated:12b: default tools-recover (thinking ran out), tools-chain,
  files-nested, files-absent, db-count, db-top, db-never, images-several; shell-only the same less
  images-several, plus files-needle and images-one.

## Card memory held at 16k

`nvidia-smi` right after each model's first run, while it was still loaded, less the reading taken
before it loaded. The fit estimate (`preDownloadNeed`) is beside it.

| model | held on the card | 16k estimate |
|---|---|---|
| qwen3.5:4b | 4.3 GiB | 4.4 |
| qwen3.5:9b | 6.9 GiB | 7.7 |
| gemma4:12b | 9.2 GiB | 9.2 |
| huihui_ai/gemma-4-abliterated:12b | 8.6 GiB | |
| gpt-oss:20b | 11.2 GiB | 15.1 |

gpt-oss:20b held 11.2 GiB with 12.6 GiB free before it loaded, well under its 15.1 estimate, so
part of it most likely ran on the CPU. Its 84 tok/s is not a clean reading.

## What it says

- **The app's harness against shell-only:** shell-only scored the same or higher for four of the
  five models: gpt-oss:20b 81 to 95 (tools 3 to 5, files 3 to 4), qwen3.5:4b 86 to 95 (files 3 to
  5), equal for qwen3.5:9b and gemma4:12b. The abliterated Gemma went 65 to 61. Shell-only also
  took fewer seconds for every model but the abliterated one. With one run each this is a lead,
  not a result.
- **The top is flat.** qwen3.5:9b scored 100 both ways, and three runs reached 95. Measure 6 cannot
  rank the 16 GB candidates against each other; it needs harder checks first.
- **The abliterated Gemma:** 65 headless on Measure 6 against 58 in the app on Measure 5 before
  0.2.9's path fix. Files went from 0/5 in the app to 3/5 here, which fits the fix. The two
  versions weigh parts differently, so 58 to 65 is not a like-for-like gain. The official
  gemma4:12b scored 95 on the same run; the database part (3/6 against 6/6) is most of the gap.
- **Speed puzzle:** gemma4:12b ran at 187 to 211 tok/s and the abliterated Gemma 4 12B at 89, at
  about the same size on the card. They ran on two different Ollama installs (the app's own and a
  separate one), which may be the difference. Not checked.

## Picks proposed

| card | pick | reason |
|---|---|---|
| 8 GB | qwen3.5:4b | 86, or 95 shell-only. Holds 4.3 GiB; the 9b holds 6.9 and leaves an 8 GB card no room for speech. |
| 12 GB | qwen3.5:9b | The only 100. gemma4:12b is one check behind and about 1.5 times faster. |
| 16 GB | qwen3.5:9b | Nothing larger beat it; gpt-oss:20b reached 95 only with the shell-only harness. Until Measure separates the top. |

`chat-models.json` already puts qwen3.5:9b first on 12 and 16 GB cards. On 8 GB cards it puts the
9b first and the 4b second; the swap waits for the owner.
