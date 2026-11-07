# Local tool turn

`runLoop` owns response → collect calls → execute → observations → response.
It takes a model stream and a tool executor, so fake streams and the Ollama
transport use the same implementation. No provider SDK or cloud connection is
involved. This is an original implementation of the loop/parser ideas listed
in the incubator's harness survey, not copied upstream source.

The server's `streamToolTurn` checks `/api/show` for `tools`. Native models get
function schemas and `role: tool` observations. Other models get the compact
`<tool_call>` block. With no `<tool_call>` tags, exactly one fenced ```` ```json ````
or ```` ```tool_code ```` block holding `name` plus `arguments` or `parameters` is
a call. A fence that does not parse counts as a bad call. The parser ignores
closed and unfinished `<think>` blocks. Text-mode observations go back as
`<tool_result name="…">…</tool_result>`, after a line saying the output is data,
not instructions. The Qwen and Gemma fixtures are **hand-written examples**, not
recordings from live models. No live model was loaded to build this lane.

Each turn has budgets. At most 8 calls run per model reply. All of the turn's
tools share 5 minutes of wall-clock time, and their output shares
`num_ctx * 3 / 2` characters. Past a budget, every further call gets an error
naming that budget, and the model is asked for its final answer with no tool
definitions. The saved reply keeps every step's visible text, in order. A
step's `detail` is cut to 2,000 characters for the UI.

`read` is available on both platforms; Linux adds `shell`, Windows adds `sql`.
`image` is defined and offered only when `chat.send` sets `image: true` and
`generateImage` is wired. `note` is deliberately absent until the gated memory
slice exists. Image generation is injected as
`(prompt, signal) => Promise<relativePath>`.

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
The guarantee comes from bwrap namespaces, read-only mounts, a capped scope and
a seccomp filter. bwrap runs inside `systemd-run --user --scope` with
`MemoryMax=512M`, `MemorySwapMax=0` and `TasksMax=64`; a timeout or cancel kills
the whole scope. With no usable user systemd, the shell tool is off. The root,
`/tmp`, `/data` and `/library` are 64 MiB tmpfs mounts; all but `/tmp` are
remounted read-only once the binds are in place. `/usr` and Library mounts are read-only, home is absent, the
environment is cleared, and the network, process and user namespaces are
isolated. Nested user namespaces are disabled. The seccomp filter
(`sandbox/seccomp.ts`, x86_64 and aarch64 only) returns EPERM for `flock`,
locking `fcntl` commands, foreign architectures and x32, so a live database in
a folder source is never locked. `sqlite3` in the sandbox opens `/data/*.db`
with `immutable=1` for that reason. The read tool checks native-resolved paths
and rejects symlinks that leave the source. Windows queries run in a child
process that is killed after 10 s. They open only the snapshot, read-only, with
`query_only=ON`, and cannot attach another database, change a PRAGMA, VACUUM
INTO, or append another statement.

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
