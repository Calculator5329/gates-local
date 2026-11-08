# Third-party notices

Gates Local is MIT licensed (`LICENSE`, Copyright (c) 2026 Ethan Gates).
The root license does not relicense anything listed here.

## T3 Code

- **License:** MIT, Copyright (c) 2026 T3 Tools Inc. Full text in
  `LICENSES/T3-Code-MIT.txt`.
- **Source:** T3 Code (github.com/pingdotgg/t3code), read from a local fork
  checked out at commit `d137c5081ac5efb2b8ea9aec8b334e1bb4d0182a`
  (2026-10-23), whose upstream base is
  `a4cc1367b03ee0c1dc2b50fceac81ef5e63212e2`. That checkout's HEAD did not
  move between 2026-10-23 and the design work on 2026-11-07, and the lifted
  files carry no uncommitted edits there.
- **What was adapted:** layout and styling, not application code: the token
  structure, radius scale, spacing, scrollbar and composer values from
  `apps/web/src/index.css`, the layout of the sidebar, header, timeline,
  composer, context meter, model picker, status banner, pending-approval
  panel and button/popover/kbd components, and the send-arrow path. The
  per-file list is in `docs/design/round-2-t3-faithful.md` and
  `docs/design/round-2-instrument.md`. No T3 name, logo, provider icons or
  copy are used.
- **Files:** `docs/design/round-2-instrument.html`,
  `docs/design/round-2-t3-faithful.html`, `docs/design/shell.html`,
  `apps/web/src/styles.css`, `apps/web/src/icons.tsx`,
  `apps/web/src/App.tsx` (the header), `apps/web/src/Sidebar.tsx`,
  `apps/web/src/Thread.tsx`, `apps/web/src/Composer.tsx`,
  `apps/web/src/Banner.tsx`. Each carries a one-line header pointing at the
  notice file.

## Lucide icons

- **License:** ISC, Copyright (c) Lucide Contributors 2026, with portions
  MIT, Copyright (c) 2013-2026 Cole Bemis, as part of Feather. Full text in
  `LICENSES/Lucide-ISC.txt`, copied from `lucide-react` 0.564.0.
- **What was used:** the icon sprite's line icons are Lucide icons, some
  copied path for path and some redrawn with rounded coordinates. The gate
  mark (`i-mark`) is this project's own. No Lucide package is a dependency.
- **Files:** `apps/web/src/icons.tsx`, `docs/design/shell.html`,
  `docs/design/round-2-t3-faithful.html`,
  `docs/design/round-2-instrument.html`. Each carries a one-line header
  pointing at the notice file.

## Image workflow

`apps/server/src/image/workflow.ts` is ported from the SDXL Lightning
workflow in local-ai-lab, Ethan Gates's own repository (written in commit
`d2e58f5` there). Same author, so it is covered by this repository's MIT
license. The checkpoint and LoRA it names are not included: model weights
are downloaded separately and come under their own licenses.

## MPL-2.0 build dependencies

`lightningcss` and its native package `lightningcss-linux-x64-gnu` (1.33.0)
are MPL-2.0. They come in only as build-time dependencies of Vite (a dev
dependency of `apps/web`) and are not imported by the app at runtime or
included in this repository. Anyone who redistributes those packages takes on
their MPL-2.0 notice and source-availability terms.
