# Gates Local

> **Asked to set someone up, or to "look at this folder"?** Follow
> [docs/setup/with-claude-code.md](docs/setup/with-claude-code.md). The rest of
> this file is for people changing the code.

A Linux desktop app for running AI on your own machine, built for one power
user with a 16 GB GPU first. Electron supervises a local Node server that
finds and starts Ollama, lists models and manages context up to 64k
where measured fit allows, never past what a model takes. Local tools read the docs library and
the databases the owner explicitly adds. Image generation uses the local
ComfyUI setup when enabled. Built-in benchmarks choose model and profile
defaults from real runs on this machine. Memory is gated: "remember" saves a
note; model and dream changes wait as diffs.

Origin and rulings: the maintainer's private planning folder for this
project, not published (promoted 2026-11-07). That folder is frozen; new
decisions go in `docs/decisions.md` here. GatesAI (the maintainer's separate
chat app) stays a separate product; replacing it at full parity is a later
decision.

## What it does not do

- No cloud, API keys, embeddings or MCP servers in v1.
- Linux first, Windows second (Ethan, 2026-11-07; `docs/decisions.md`).
  No macOS in v1.
- Never stops, evicts, restarts or reconfigures whisper. Chat, images,
  benchmarks and dreaming fit around it. Other GPU holders (media-vault,
  browsers) are occupants the fit check measures, never processes the app
  stops.
- Never adopts or stops an Ollama or ComfyUI it did not start.
- Connects no personal store on its own. Sources are read-only snapshots the
  owner adds.
- No unattended edit of live notes. Model and dream changes are proposals.
- No public repository, release or deploy without Ethan's explicit go.

## Run and verify

- `pnpm verify` is the gate: root and per-package `tsc`, `oxlint
  --deny-warnings`, `vitest run`. It must fail on a planted type error.
- Node 24 runs the TypeScript sources directly (type stripping): erasable
  syntax only, relative imports end in `.ts`. Electron 45 ships Node
  24.22, which has `node:sqlite` and type stripping too.
- Dev ports: server 127.0.0.1:5186, web (Vite) 127.0.0.1:5187. Long-lived
  dev processes start with `systemd-run --user --collect --unit <name>`.
- Real-runtime checks (Ollama, GPU fit, Electron windows) are separate from
  `pnpm verify`, which uses fakes only.

## Layout (who owns what)

- `packages/contracts/`: the wire. One WebSocket, typed RPC and push
  channels, Effect Schema decode at both ends. Changes to a shipped channel
  come from the coordinating session.
- `apps/server/src/ws/`: the server side of that WebSocket; `index.ts`
  composes the modules below.
- `apps/server/src/threads/`: SQLite WAL thread store. Completed messages
  persist; token deltas stay in memory.
- `apps/server/src/runtime/`: Ollama discovery, the app-owned install in
  the app folder, process ownership, the model list.
- `apps/server/src/chat/` and `apps/server/src/fit/`: the streamed turn
  with an explicit per-request `num_ctx`, and the fit check against
  measured free VRAM.
- `apps/desktop/`: Electron main and preload; supervises the server.
- `apps/web/`: the client. Its look waits for Ethan's mockup picks.
- `packages/harness/`: the turn loop and four tools (slice 4).

## Conventions

- Effect Schema at the boundaries (wire, files, runtime responses). Plain
  TypeScript inside a module unless a lane shows a reason.
- Tests sit next to the code (`*.test.ts`) or in the package `test/`.
  Fakes for Ollama, nvidia-smi and processes live with the module that uses
  them.
- GPU: measure free VRAM before any real load; never exceed it; never set
  `num_gpu` 0; unload what a check loaded. Whisper is never touched.
- Git: plain `git commit`, stage only your files, never `git stash`, never
  `worktree remove --force`, no remote until Ethan says so.
- Files ported from another repo start with a comment naming the origin
  path and commit, and keep the origin's shape so later fixes still merge.
