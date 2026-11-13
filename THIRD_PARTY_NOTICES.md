# Third-party notices

Gates Local is MIT licensed (`LICENSE`, Copyright (c) 2026 Ethan Gates).
The root license does not relicense anything listed here.

## Optional sample databases

No database is bundled or downloaded at startup. Library downloads the selected
SQLite file only when the person clicks Download. The pinned URLs, byte counts
and SHA-256 digests live in `apps/server/src/sources/samples.ts`.

- **Chinook:** MIT, Copyright (c) 2008-2024 Luis Rocha. Reviewed at
  [upstream commit 7f677725](https://github.com/lerocha/chinook-database/blob/7f67772503d71ba90f19283c38e93923addb43fa/LICENSE.md).
- **Northwind SQLite:** MIT, Copyright (c) 2016 JP White. Reviewed at
  [upstream commit 4f56e7f5](https://github.com/jpwhite3/northwind-SQLite3/blob/4f56e7f5906dfd23b25244c5bfe8fb5da6402efd/LICENSE).
- **World Cup:** [CC BY-SA 4.0](https://creativecommons.org/licenses/by-sa/4.0/),
  © 2023 Joshua C. Fjelstul, Ph.D. Reviewed at
  [upstream commit 35a8667f](https://github.com/jfjelstul/worldcup/blob/35a8667f518b07469182ae16d35574dd0e7a00fb/README.md#the-license).
  The file is downloaded unchanged.
- **Periodic table (mendeleev):** MIT, Copyright (c) 2015 Lukasz Mentel. Reviewed at
  [upstream commit bd4716bf](https://github.com/lmmentel/mendeleev/blob/bd4716bff94c7acf22210d6ffb75dbd1fcc4f9bc/LICENSE).

Each sample's notice (its source, copyright and licence: the MIT text in
full, or the CC BY-SA 4.0 link) is built in `samples.ts` as its `notice` and
saved beside that sample's downloaded database as
`LICENSE.txt`; a copy never carries another sample's notice.

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

The built-in setups in `apps/server/src/image/setups/` come from two places
(details in that folder's README):

- The FLUX.2 Klein graphs (`flux2-klein-4b*.json`) and the checkpoint graph
  for a person's own SDXL files (`sdxl-checkpoint.json`) are ported from
  workflows in local-ai-lab, Ethan Gates's own repository (commits
  `fd7abb65` and `d2e58f5` there; the second was its SDXL Lightning
  workflow, which the app no longer offers). Same author, so they are
  covered by this repository's MIT license.
- `z-image-turbo-int8.json` and `moss-image.json` are converted from Comfy
  Org's Z-Image Turbo int8 and MOSS-Image workflow templates
  (`comfyui-workflow-templates-json` 0.1.132). That package's metadata
  says `License-Expression: MIT` and it ships no licence file of its own;
  the MIT text, Copyright (c) 2023-present Comfy Org, from the main
  `comfyui-workflow-templates` package is at
  `apps/server/test/comfy/templates/LICENSE`, beside the trimmed copies of
  both templates.

The model files they name are not included. The picker downloads them on
request from the revision-pinned Hugging Face addresses in
`setups/files.json`, and they come under their own licenses. Those licenses
are **unverified**: no licence text for any of these weights is in this
repository or was read for it. `files.json` records what each model card
states:

| Model files | Card says |
| --- | --- |
| FLUX.2 Klein 4B fp8 (Black Forest Labs) | Apache License 2.0 |
| Qwen3 4B text encoders, full and FP4, and the FLUX.2 VAE (Comfy-Org's FLUX.2 Klein 4B repackage) | Apache-2.0 |
| Z-Image Turbo int8, its Qwen3 4B fp8 encoder and VAE (Comfy-Org's Z-Image Turbo repackage) | apache-2.0 |
| MOSS-Image int8 and its Qwen3.5 9B w4a8 encoder (Comfy-Org's MOSS-Image repackage) | apache-2.0 |

## ComfyUI workflow templates (test fixtures)

`apps/server/test/comfy/templates/` holds six of ComfyUI's workflow
templates: four from the `comfyui-workflow-templates` package 0.11.106 and
the Z-Image Turbo int8 and MOSS-Image ones from its
`comfyui-workflow-templates-json` part 0.1.132 (MIT by its metadata). MIT,
Copyright (c) 2023-present Comfy Org, full text beside them in `LICENSE`, from
the main package. Three are copied
unchanged; MiniMax H3, Z-Image Turbo int8 and MOSS-Image have their
editor-only fields taken out, and MOSS's prompt-enhancer system prompt is cut
to its first sentence. They are test inputs and are not shipped in the app;
the two setups converted from them are (see "Image workflow").
`apps/server/src/image/convert.ts`, which turns such files into the graphs
ComfyUI runs, was written for this repository from the file format and
ComfyUI's `/object_info` answer; no code from ComfyUI's GPL-3.0 frontend was
read or copied.

## Picture thumbnails

The server makes the Pictures screen's thumbnails with two runtime
dependencies of `apps/server`, used unchanged from npm:

- **`@jsquash/webp` 1.5.0:** Apache-2.0, Copyright the jSquash authors; the
  license text ships in the package as `LICENSE`. It encodes the WebP files.
  Its WebAssembly codec is built from Google's libwebp, BSD-3-Clause,
  Copyright (c) 2010 Google Inc.; the package's `codec/README.md` names that
  source and license.
- **`pngjs` 7.0.0:** MIT, Copyright (c) 2015 Luke Page & Original
  Contributors, and Copyright (c) 2012 Kuba Niegowski for the derived work;
  the license text ships in the package as `LICENSE`. It reads the PNGs that
  ComfyUI saves.

## MPL-2.0 build dependencies

`lightningcss` and its native package `lightningcss-linux-x64-gnu` (1.33.0)
are MPL-2.0. They come in only as build-time dependencies of Vite (a dev
dependency of `apps/web`) and are not imported by the app at runtime or
included in this repository. Anyone who redistributes those packages takes on
their MPL-2.0 notice and source-availability terms.
