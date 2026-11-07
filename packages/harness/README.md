# Local tool turn

`runLoop` owns response → collect calls → execute → observations → response.
It takes a model stream and a tool executor, so fake streams and the Ollama
transport use the same implementation. No provider SDK or cloud connection is
involved. This is an original implementation of the loop/parser ideas listed
in the incubator's harness survey, not copied upstream source.

The server's `streamToolTurn` checks `/api/show` for `tools`. Native models get
function schemas and `role: tool` observations. Other models get the compact
`<tool_call>` block. The parser ignores closed and unfinished `<think>` blocks.
The Qwen and Gemma fixtures are **hand-written examples**, not recordings from
live models. No live model was loaded to build this lane.

`read` and `image` are available on both platforms; Linux adds `shell`, Windows
adds `sql`. `note` is deliberately absent until the gated memory slice exists.
Image generation is injected as `(prompt, signal) => Promise<relativePath>`;
an absent implementation returns “Image generation is not set up”.

Sources are supplied per turn. SQLite paths point only to snapshots and are
mounted at `/data/<id>.db`; files and folders appear at `/library/<id>`. The
source labels and IDs appear in the system message. The tool instructions and
schemas stay under an **estimated** 1,000 tokens using 3 characters/token; this
is not a tokenizer measurement and the variable Library listing is separate.
Tool output sent to the model is limited to 10,000 characters, with 5,000 at
each end and an elision count when longer. Linux processes also have a hard
100,000-byte output cap and a 30-second maximum time limit.

The explicit safety requirements in the brief require refusals: warnings or
prompt instructions cannot protect personal files from an arbitrary shell.
The guarantee comes from bwrap namespaces and read-only mounts. The root is
tmpfs, `/usr` and Library mounts are read-only, home is absent, environment is
cleared, and networking and process namespaces are isolated. The read tool
checks resolved paths and rejects symlinks that leave the source. Windows
queries open only the snapshot, read-only, with `query_only=ON`; they cannot
attach another database, change a PRAGMA, or append another statement.

## Verification

`pnpm verify:tools` runs fake Ollama transport tests, parser/loop/tool probes,
the `app.ts` send-and-persist probe, and real bwrap confinement tests. A one-time
bwrap probe skips confinement tests only when bwrap is missing or namespace
creation is denied. A broken mount or a confinement failure never becomes a
skip. These tests were added in this lane and are diagnostic probes; the
coordinator's outside-sandbox run and review are the acceptance evidence.

`pnpm verify:sources` exercises the persisted registry and WAL snapshots. The
concurrent writer is a separate Node process. A one-time child-process probe
names an EPERM/EACCES restriction as a skip; actual snapshot or writer failures
remain failures when process creation works.

The coordinator must run both scripts and `pnpm verify` outside the restricted
lane, where listeners, child Node processes and normal test-cache paths work.
No real Ollama, ComfyUI, GPU or whisper operation is in these checks. Native
Windows execution and live Qwen/Gemma tool turns remain real-runtime checks.

The settings lane should wire `createApp({ toolsEnabled: () => settings… })`.
Explicit `chat.send.tools` overrides that default. The image lane can wire
`generateImage`. Without those injections, the explicit per-turn tools flag
works and image generation reports that it has not been set up. Context
compaction remains the separate context-accounting roadmap item.
