# Decisions

The rulings before 2026-11-07 live in
`~/projects/planning/incubator/local-ai-app/decisions.md` (D1 to D8 and the
media-vault ruling). New decisions are appended here.

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
