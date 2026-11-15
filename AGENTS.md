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
- The repository is public on GitHub under MIT, so nothing private goes in
  code, docs, tests or commit messages. No release, tag or deploy without
  Ethan's explicit go.

## Run and verify

- `pnpm verify` is the gate: root and per-package `tsc`, `pnpm lint`,
  `vitest run`. It must fail on a planted type error.
- `pnpm lint` is two passes: `oxlint --deny-warnings` with its stock checks,
  then the project's own rules (`lint/rules.oxlintrc.json`, plugin in
  `lint/`). Code that broke a project rule before the rule existed is
  counted per rule and file in `lint/baseline.json`. A count may fall and
  never rise, and a new file starts at zero. After moving or splitting files,
  or after removing an offender, run `pnpm lint:baseline` and commit the
  file; it refuses when a rule fires more often across the repo than before.
  Never edit `lint/baseline.json` by hand.
- `pnpm build` reports the shared entry JS, total JS, startup CSS and total
  CSS soft gzip targets in `test/bundle-size.ts`. Startup CSS counts HTML stylesheet
  and style-preload links; total CSS counts every emitted stylesheet.
  Size overages warn and never block a build, test, release check or landing.
  Never raise a target to make a build pass. A lane that passes a target says
  what it added and why in its report so obvious bloat gets noticed in review.
  Missing assets and unmeasurable sizes still fail. Timing comparisons remain
  informational too.
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
- `apps/server/src/threads/`: SQLite WAL thread store. A streaming reply
  is one row marked interrupted, rewritten about once a second.
- `apps/server/src/runtime/`: Ollama discovery, the app-owned install in
  the app folder, process ownership, the model list.
- `apps/server/src/chat/` and `apps/server/src/fit/`: the streamed turn
  with an explicit per-request `num_ctx`, and the fit check against
  measured free VRAM.
- `apps/desktop/`: Electron main and preload; supervises the server.
- `apps/web/`: the client. Its look is settled: black and gray with green,
  as recorded in `docs/decisions.md`. `src/` has one folder per feature
  (`app/` for the shell and `styles.css`, then `composer/`, `thread/`,
  `sidebar/`, `picker/`, `models/`, `fit/`, `runtime/`, `settings/` and
  the rest); nothing sits at the top of `src/`. Shared code is in
  `src/lib/`: `store/` (the store and drafts), `session/` (the
  connection and server actions), `ui/` and `words/`. A feature's tests
  sit beside its files; `apps/web/test/` keeps only the shared helpers
  (fake DOM, harness, ordering replay). Window tests reach server and
  harness code through `@gates-local/server/...` and
  `@gates-local/harness`, never a relative path across apps.
- `packages/harness/`: the turn loop, the tools a model can call and the
  sandbox they run in.
- `packages/update/` holds the updaters and process state both apps use; `packages/runtime-files/` holds the app's Ollama paths and ownership record. No app imports another app's files.

## Conventions

- Effect Schema at the boundaries (wire, files, runtime responses). Plain
  TypeScript inside a module unless a lane shows a reason.
- Tests sit next to the code (`*.test.ts`) or in the package `test/`.
  Fakes for Ollama, nvidia-smi and processes live with the module that uses
  them.
- GPU: measure free VRAM before any real load; never exceed it; never set
  `num_gpu` 0; unload what a check loaded. Whisper is never touched.
- Git: plain `git commit`, stage only your files, never `git stash`, never
  `worktree remove --force`. Lanes never push; a coordinating session
  lands on `dev` and pushes it.
- Branches: work lands on `dev`, and lanes are cut from `dev`. `main` is
  the last released commit and moves only when a release is cut, so a
  release check never holds up work. Nothing lands on `main` directly.
- Files ported from another repo start with a comment naming the origin
  path and commit, and keep the origin's shape so later fixes still merge.

## Rules and what enforces them

When a correction turns into a rule, it is added to this table in the same
commit as the check that enforces it; a rule nothing checks yet says "prose",
and is the next one to get a check.

| Rule | Enforced by |
| --- | --- |
| A relative import stays inside its app or package; another package is imported by name. | lint `gates/no-relative-import-across-packages` |
| No two files import each other at run time, directly or through others. | lint `import/no-cycle` |
| `packages/contracts` imports its own files and `effect`, nothing else. | lint `gates/closed-package` |
| The sandboxed preload, and the files it shares, import no Node, no Electron main and no server code. | lint `eslint/no-restricted-imports` |
| A relative import ends in `.ts`; an import used only as a type is `import type`; erasable syntax only. | lint `import/extensions`, `typescript/no-import-type-side-effects`; `tsc` (`erasableSyntaxOnly`, `verbatimModuleSyntax`) |
| No `any`, no `@ts-ignore`. | lint `typescript/no-explicit-any`, `typescript/ban-ts-comment` |
| A lint rule is switched off by name, with the reason on the same line. | lint `unicorn/no-abusive-eslint-disable`, `gates/disable-needs-reason` |
| No TODO, FIXME, XXX or HACK comment: finish it, or put it in `docs/roadmap.md`. | lint `eslint/no-warning-comments` |
| An effect in the window's code keeps something outside React in step, and says what. | lint `gates/effect-needs-reason` |
| A timer in the window's code is there because time is the point, and says what it waits for. | lint `gates/timer-needs-reason` |
| A browser test waits for a condition, never for a length of time. | lint `gates/no-wait-for-timeout` |
| No focused or skipped test is committed. | lint `vitest/no-focused-tests`, `vitest/no-disabled-tests` |
| The window draws its own lists and menus; no native `<select>`. | lint `react/forbid-elements` |
| No raw HTML is put into the window. | lint `react/no-danger` |
| A page the model wrote runs sandboxed in its own frame and learns nothing of the app. | test `test/e2e/pages-lockdown.spec.ts` |
| Every wire method decides whether the phone may call it; the phone is for chat only. | type: the required `phone` field in `packages/contracts/src/protocol.ts`; test `test/e2e/phone.spec.ts` |
| Data crossing a boundary (wire, files, runtime responses) is decoded with Effect Schema. | type for the wire: the `methods` table in `packages/contracts/src/protocol.ts`; prose elsewhere |
| A reply's stage and running state come from the server as one typed value; the window only draws it. | type `ReplyStage` in `packages/contracts/src/shapes.ts` |
| A statement about fit carries what it was measured against. | type `FitBasis` in `apps/server/src/fit/fit.ts` |
| A chat request never sets `num_gpu`. | tests `apps/server/test/app.test.ts`, `test/e2e/paste.spec.ts` |
| Heavy GPU work goes through the one lease, one job at a time, and never touches whisper. | test `apps/server/src/gpu/lease.test.ts` |
| Free VRAM is measured before a real load and never exceeded; a check unloads what it loaded. | prose |
| The app stops only processes it started. | prose |
| A screen is whole on its first frame: placeholders hold the space, nothing arrives late or moves. | test `test/e2e/flicker-audit.spec.ts`; bug finder kinds `moves`, `resized`, `late`, `flicker` in `test/finder/detectors.ts` |
| A screen says a thing once. | bug finder kind `twice` in `test/finder/detectors.ts` |
| No description line under a title; a tooltip only names an icon-only button. | prose (`docs/design.md`, Settings text) |
| Icons and numbers before words. | prose |
| Every control on screen does something; one that does not is removed. | bug finder walk `test/finder/walk.spec.ts`; prose |
| Settings, Models and Usage open in the one pop-up frame. | prose (`Dialog` in `apps/web/src/Panel.tsx`) |
| Black and gray with one accent; no gradients, no glass, no rounded-everything, no orphan rows. | prose (`docs/design.md`, Look) |
| First run needs nothing from the user but a model choice: the app finds or installs its runtime. | tests `test/e2e/first-run*.spec.ts`; prose for a machine with nothing installed |
| The context window follows the model and never passes what the model takes. | prose |
| Model lists, setups and tiers are data files, read by code. | prose |
| An error is handled or passed on; a catch that drops one says why that is safe. | prose |
| A fix goes to the cause; a delay or a retry that hides an ordering problem is not a fix. | prose; the timer and wait rules above catch the common shape |
| Local only: no cloud, API keys, embeddings or MCP servers. | prose |
| Nothing private in code, docs, tests or commit messages. | prose |
| Bundle size targets warn and never block; a target is never raised to pass. | `test/bundle-size.ts`, run by `pnpm build` |
| `pnpm verify` runs on fakes only; checks against a real runtime are separate commands. | prose |
| Tests guard what was decided; the bug finder covers the rest before a larger suite does. | prose |
| Work lands on `dev`; review happens at the release check; no release, tag or deploy without the maintainer's go. | prose |

A lint rule's own message says what to write instead. Each has a planted
mistake and its fixed form in `lint/rules.test.ts`; a new lint rule gets a
case there, and that file fails until it has one.
