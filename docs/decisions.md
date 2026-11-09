# Decisions

The rulings before 2026-11-07 (D1 to D8 and the media-vault ruling) live in
the incubator decisions file in the maintainer's private planning
workspace, which is not published. New decisions are appended here.

## 2026-11-07 · Promotion

**Decided:** promoted on Ethan's start in chat ("start dispatching
sub-agents for putting together the foundation", with Opus 5.5 high
sub-agents). Agent calls, with a veto: home `ai/gates-local`, manifest
category `ai`, agents fence `full`, a local git repository with no remote.
Toolchain pinned by the first install: pnpm 11.10, TypeScript 7.0, Vitest
5.1, oxlint 1.92, Effect 4.1, Electron 45.2 (Node 24.22).
**Why:** `ai/` holds the sibling GatesAI and local-ai-lab repos; `full`
because Ethan asked for agents on the foundation; no remote because a public
repository needs his explicit go.

## 2026-11-07 · Visual direction by GPT-image rounds

**Decided:** the look is chosen from generated mockups, not prose. Round 1 is
twelve divergent directions of one hero screen
(`~/.cache/gates-local-mockups/round-1/`); Ethan narrows them; round 2 shows
many screens under each kept direction. `apps/web` stays unstyled until a
pick lands.
**Owner text (voice-to-text, in chat):** “We can have a bunch of different
options and then once we narrow in on options we can show many different
screens under that option to even more narrow in on exactly how that entire
option feel.”

## 2026-11-07 · Round 1 rejected; round 2 is T3 Code-shaped HTML

**Decided:** all twelve round-1 looks are dropped. The layout follows T3
Code: sidebar, header, timeline, and the composer as the control centre. Fit,
GPU and runtime facts live in composer chips, popovers and banners, not in
permanent strips. Round 2 is two HTML design harnesses
(`docs/design/round-2-t3-faithful.html`, `docs/design/round-2-instrument.html`)
built from T3 Forge's real tokens and components (MIT). Each has switchers for
the open taste choices and covers seven screens.
**Why HTML, not images:** the polish Ethan found missing is exact spacing, type
and restraint. Image generation invents those every time, and an HTML harness
holds them. The images also failed because the prompts crammed every feature
onto one screen as chrome. A GPT-image round anchored on a T3 Code screenshot
is still available if he wants to compare.
**Owner text (voice-to-text, in chat):** “None of those look exactly right.
Like the layout is too basic and too messy and think more T 3 code-like and I
don't know, they just don't look polished at all.”

## 2026-11-07 · Black and gray with green; a council hill climb picks the polish

**Decided:** the look is dark mode, black and gray, with green highlights. It
must work out of the box: a first-time user reaches a reply from a local model
without opening settings, and settings hold the further customization. This
overrides the round-2 brief's default accents (T3 blue, graphite and amber)
and its "avoid dark green" note; the generic-tells review still applies.
Polish is decided by a design council hill climb modeled on Theo's 2026-11-03
video: Claude Opus 5.5 and GPT-6.1 Sol score screenshots per category beside
professional alternatives each round, an implementer fixes the findings, and
the loop repeats until Gates Local scores at or above every reference
(`docs/design/council-rubric.md`). Ethan's replies to round screenshots
outrank any score.
**Owner text (voice-to-text, in chat):** “have the council evaluate the
overall design, professionalness, UI UX, in the same way as T3.GG did in a
recent video… comparing it to the scores and ratings of professional
alternatives to the app and then just autonomously iterating over and over to
improve.” And: “I was thinking kind of dark mode, black and gray, with maybe
some green highlights. Sleek and professional. Very easy and simple to use
right out of the box. Connects with local models very simply and easily. And
then you can go into settings and customize further in all the ways that
we've discussed. But you don't necessarily have to to have it working out of
the box.”

## 2026-11-07 · The real app end to end, on Linux, then Windows

**Decided:** while the design council keeps climbing, build the real app to
the shell design (`docs/design/shell.html`, `shell.md`): the React client in
`apps/web`, end-to-end tests, performance budgets, seamless Ollama (find,
load, download, switch models) and GPU management, seamless ComfyUI,
approachable Settings, and personal databases and tool calls through the
Library. Linux on the maintainer's Linux machine first. Then Windows on a
Windows test machine with no NVIDIA GPU (Intel UHD 630, 16 GB), by a
delegate working on that machine. This lifts "Linux only in v1" in
`AGENTS.md`; macOS stays out.
**What Windows changes (agent calls, with a veto):** the Windows test
machine has no NVIDIA GPU, so models run on the CPU there; the GPU status
reports `vendor: "none"`, the fit check reads system memory, and the GPU
panel says so in plain words. Whisper does not run there. bwrap does not
exist on Windows, so the `shell` tool is off on Windows and `read` and `sql`
run in-process against read-only snapshots.
**Contracts:** the coordinator added the v2 method and push table (settings,
GPU status, catalog, downloads, Library sources, tool steps, images) before
the lanes started, so the client and the server lanes build against one
table. A method with no handler answers `not-implemented`.
**Owner text (voice-to-text, in chat):** “continue on the UI/UX scores and
council scores and like getting it up to as good as the best references. Also
making sure we have end to end tests and performance is great and that it's
seamless with Ollama and loading things in and managing GPU and seamless with
comfy UI and that the settings are very approachable and easy to understand
and configure and being able to hook into personal databases and tool calls
and stuff.You could also make sure it's working on Linux on this computer and
then if you have time, run a sub-agent on Jord y to get it working on that
Windows computer so it's working for both.”

## 2026-11-07 · Setup with an AI assistant, on any device

**Decided:** Gates Local ships a `setup/` folder that a coding agent (Claude
Code, Codex) can be pointed at: "look at this folder and set me up". The
agent reads the folder's `AGENTS.md` (`CLAUDE.md` points to it), runs the
app's own probe to read the device (OS, GPU vendor and memory, system
memory, disk, CPU, what is already installed), asks the app for a plan (the
best text model and context, the best image model or none, what downloads
and how big), shows the plan, and on the user's yes runs the app's own
install and download commands, then checks with one reply and, where images
are on, one image. The manual path stays: first run already installs Ollama
and one model by itself; the agent path adds what first run leaves out
(image generation, more models, Library sources, tuning).
**Any device:** the plan comes from the measured device, never one fixed
default. A device with no GPU gets text models sized to its system memory,
and image generation offered only as the smallest CPU-capable model with
its measured time per image, off unless the user says yes.
**The app does the deciding, the agent does the talking:** the probe, the
model choice and the installs are app commands with JSON output and tests
(`pnpm setup:probe`, `setup:plan`, `setup:apply`), so a fresh agent on any
machine gets the same answer and Settings can show the same plan with no
agent at all. The folder's instructions keep the agent to: run, show, ask,
apply, check, report.
**Models:** a dated tier table in the repo (text and image per hardware
tier, each with its source, download size, memory at 16k and license),
researched now and refreshed per release. An agent may suggest a newer
model it finds, and installs it only on the user's yes.
**Agent rules in the folder:** official sources and published checksums
only; sizes shown before any download; nothing system-wide without asking;
never stop a process the app did not start; on the maintainer's Linux
machine the GPU rules in `AGENTS.md` apply (whisper is never touched).
**Proof:** the Windows lane on the Windows test machine (no GPU) is the
first real test: a fresh agent there is pointed at the folder and sets the
app up.
**Owner text (voice-to-text, in chat):** “Also it'd be nice if in the setup
it had setup instructions in a way that like I could download it, install
it, and then like tell Claude code "hey look at this folder" and it could get
me set up with the best of models in terms of local image generation and
text like automatically. Like a Claude enabled setup if you don't want to do
it manually that'd be kind of cool and then work on any device even if it
doesn't have a GPU like it gets whatever is the best that your device can
handle.”

## 2026-11-07 · Models settings: installed, default, download

**Decided:** the Models page does three jobs and no others: the models on
this computer, the default model for new chats, and downloading new
models. No per-model character, system prompt or temperature there; system
prompts get their own home later, if wanted. The Milo character mode is
not supported for now. The layout starts from option A of the three shown
(tabs for "on this computer" and "download", a table of installed models)
and is refined for simplicity by one or two design council rounds before
the settings lane builds it.
**Agent calls, with a veto:** the context window leaves the Models page.
The model picker already sets it per chat; the default for new chats sits
under Advanced beside the GPU memory details.
**Owner text (voice-to-text, in chat):** “I would say remove the character
and system prompt stuff from models. Models should only be what models you
have installed, what's your default, and your ability to install new
models . I think that should be it. And then we can have somewhere else if
we want to do system prompts and stuff. And I was wrong to bring up the
Milo thing. We don't need to support that quite yet.” and “A ios closest
for models tabm but still needs refinement. simplicity and best UX are
priority. council session or two may help.”

## 2026-11-07 · Public repository: MIT, full history, as soon as possible

**Decided:** Gates Local becomes a public GitHub repository under
Calculator5329, MIT licensed ("Copyright (c) 2026 Ethan Gates", as in his
other MIT repositories), pushed with its full history rather than a fresh
snapshot. It goes up as soon as the publication audit has no open blocker
and the README with setup steps and screenshots has landed; Windows setup
follows from the Windows lane. This replaces the "no remote" part of the
promotion entry.
**Why full history is safe to consider:** the author address in the commit
metadata is already public through his other public repositories. The
audit reads every blob in every branch for secrets and private details
first; a finding that lives only in history comes back to Ethan before any
push.
**Owner text (voice-to-text, in chat):** “Let's do MIT for the license, and
I think we can push all 189 commits. And timing, let's just do it as soon
as possible.”

## 2026-11-07 · Full history confirmed after the audit

The publication audit found no credentials in any of the 237 commits, but
history still holds what the current tree no longer does: a captured list
of the GPU's processes with home-folder paths, the full download name of a
local model, and commit messages that name the machine. Shown that list and
the choice between full history and a fresh one-commit snapshot (the
auditor's pick), Ethan chose full history. Trigger: a friend on Windows
wants to try the app, so the repository goes public now and the Windows
lane follows.
**Owner text (in chat):** “Hey my friend is on Windows and wants to try
this out so we need to make the repo Public”, then “Full history”.

## 2026-11-08 · Instructions uses layout A

**Decided:** build layout A now: shared instructions and a per-model view under
Settings. It will be design-iterated later. Stay close to existing Settings screens;
keep sections easy to move, controls stable across state changes, and explanations
in tooltips. Reset all clears the shared prompt and every per-model override.
**Direction recorded in chat:** "The owner picked layout A, and said it still needs
iteration and will be design-iterated later, so build A now without gold-plating it."

