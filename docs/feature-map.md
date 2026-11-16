# Feature map

Every feature by the name the screen gives it, where it is, the code behind
it and the browser specs that drive it. Generated from `test/feature-map.ts`
by `pnpm feature-map`; edit that file, not this page. The wire calls and test
ids of each feature are in the data file.

Web paths are under `apps/web/src/`, server paths under `apps/server/src/`,
desktop paths under `apps/desktop/src/`. A spec is in `test/e2e/` unless it
has a path.

[Sidebar](#sidebar) · [Thread](#thread) · [Composer](#composer) · [Images in a chat](#images-in-a-chat) · [Pages](#pages) · [Models](#models) · [Usage](#usage) · [Pictures](#pictures) · [Settings](#settings) · [Library](#library) · [First run and Ollama](#first-run-and-ollama) · [Updates](#updates) · [Voice](#voice) · [Phone](#phone) · [Desktop app](#desktop-app) · [No screen](#no-screen) · [Across the app](#across-the-app)

## Sidebar

| Feature | What it is, and where | Code | Tests |
| --- | --- | --- | --- |
| **New thread** | Starts an empty chat on the model and context last used. The pen at the top of the sidebar, the chat header, or Ctrl N. | web: `sidebar/Sidebar.tsx`, `thread/threads.ts`<br>server: `app/handlers.ts`, `threads` | `sidebar-top`, `load-follow` |
| **Search threads** | Filters the thread list by title as you type. The Search field at the top of the sidebar, or Ctrl K. | web: `sidebar/Sidebar.tsx` | `sidebar-top` |
| **Threads**<br>also: thread rows, the drawer | Every chat, grouped by day, newest first; a running reply keeps its mark. The sidebar; below 1024 px, the drawer behind Open threads. | web: `sidebar/Sidebar.tsx`, `thread/threads.ts`, `app/navigation.ts`<br>server: `app/handlers.ts`, `threads` | `sidebar-running`, `threads-preload`, `sb-hairline`, `mobile`, `threads-numbered` |
| **Thread actions**<br>also: thread menu, row menu | A thread's menu: Rename, Export as Markdown, Delete. The Thread actions button that appears on a thread row under the pointer. | web: `sidebar/Sidebar.tsx`, `thread/threads.ts`<br>server: `app/handlers.ts`, `threads` | `thread-menu` |
| **Sidebar footer**<br>also: foot buttons | One row of icons: Settings, Models, Usage, Pictures and, on the desktop, the update icon. The bottom of the sidebar. | web: `sidebar/footer-state.ts`, `sidebar/Sidebar.tsx` | `sidebar-footer` |

## Thread

| Feature | What it is, and where | Code | Tests |
| --- | --- | --- | --- |
| **Reply**<br>also: turn, streaming | The model's answer, drawn word by word as it streams, the same in every window. The open thread. | web: `thread/Thread.tsx`, `thread/markdown.tsx`, `thread/paced.ts`, `thread/reveal.ts`, `thread/turn.ts`, `thread/times.ts`<br>server: `app/run-turn.ts`, `app/turn.ts`, `app/push.ts`, `chat/stream.ts`, `chat/replies.ts`, `chat/times.ts`<br>packages: `harness` | `streaming`, `writing-label`, `streaming-integrity`, `threads-resume`, `two-clients`, `text-mode-stream` |
| **Thinking** | What the model thought before it answered: a pill that grows while it thinks, then rests as "Thought for 2 s". Above a reply from a model that thinks. | web: `thread/Thread.tsx`<br>server: `chat/stream.ts` | `live-thoughts`, `thought-load` |
| **Steps**<br>also: work fold, tool calls | The tool calls a reply made, folded to one line, each one opened to show all of it. Inside a reply that used tools. | web: `thread/Thread.tsx`<br>server: `chat/tools.ts`<br>packages: `harness` | `work-fold` |
| **Reply details**<br>also: running line | The running line and, after, how long the reply took and what it waited for. Under a running or finished reply. | web: `thread/Thread.tsx`, `thread/times.ts`<br>server: `chat/send-times.ts`, `chat/send-started.ts` | `reply-ended`, `thought-load` |
| **Copy, Edit and Regenerate** | Copy a message or a code block, edit a sent message, or ask for the reply again. Under a message, at its edge; Copy code on a code block. | web: `thread/Thread.tsx`, `thread/markdown.tsx`, `lib/ui/copy.ts`<br>server: `app/handlers.ts` | `copy`, `copy-desktop`, `stop-retry` |
| **Stop** | Ends a running reply; the words so far stay, marked Stopped, with Retry. The Send button while a reply runs, or the stop square. | web: `composer/Composer.tsx`, `composer/composer-press.ts`, `thread/Thread.tsx`<br>server: `chat/reply.ts`, `chat/replies.ts`, `app/handlers.ts` | `stop-retry`, `streaming`, `reply-ended` |
| **Earlier turns**<br>also: long thread, history window | A long thread opens at its end and loads earlier turns as you scroll up. The top of a long thread. | web: `thread/Thread.tsx`, `app/App.tsx`<br>server: `threads` | `long-thread` |
| **Model change** | A line in the thread where its model changed, so each reply says who wrote it. Between turns, where the model changed. | web: `thread/ModelChange.tsx`, `thread/model-change.ts` | `mem-show` |
| **Stop the other reply?**<br>also: stop warning, blocking turn | When a send needs memory another chat holds, the app asks before it stops that chat. A pop-up on Send. | web: `composer/Composer.tsx`, `composer/chat.ts`<br>server: `app/admit.ts`, `gpu` | `stop-others`, `threads-concurrent` |
| **Replies in other threads**<br>also: background turns, concurrent threads | Replies keep running in threads you left; coming back shows them as they are. Any thread with a reply running. | web: `thread/Thread.tsx`, `composer/chat.ts`<br>server: `app/run-turn.ts`, `gpu` | `threads-concurrent`, `sidebar-running` |

## Composer

| Feature | What it is, and where | Code | Tests |
| --- | --- | --- | --- |
| **Message**<br>also: draft, textarea | The message box; each thread keeps its own draft through switches and reloads. The bottom of the thread. | web: `composer/Composer.tsx`, `composer/draft-insertion.ts`, `composer/draft-persistence.ts`, `composer/focus.ts` | `draft`, `thread-drafts`, `window-follow-ups` |
| **Send** | Sends the message; the one button becomes Stop while a reply runs and holds its place. The right end of the composer, or Enter. | web: `composer/Composer.tsx`, `composer/composer-press.ts`, `composer/chat.ts`<br>server: `app/admit.ts`, `app/handlers.ts`, `chat` | `composer-action`, `composer-panel` |
| **Messages that wait**<br>also: queue, queue tray, queued message | Messages sent while a reply runs or a model downloads: a tray with Edit, Send now and Remove. The tray above the composer. | web: `composer/Composer.tsx`, `composer/chat.ts`, `composer/records.ts`<br>server: `app/queue-pump.ts`, `chat/replies.ts`, `chat/reply.ts`, `app/handlers.ts` | `queue`, `queue-tray`, `queued-thread`, `download-queue`, `server-queue` |
| **Attach a file**<br>also: plus menu, attachments | Adds images and documents to a message, by the chooser or by dropping them on the window. The Add (+) menu in the composer. | web: `composer/attachment-images.tsx`, `composer/file-drop.tsx`, `composer/file-holds.ts`, `composer/image-compression.ts`, `composer/refused-files.ts`<br>server: `chat/attachments.ts`, `chat/files.ts`, `app/handlers.ts` | `attach-files` |
| **Paste** | Pasted text lands at the cursor with undo; a pasted image or file path becomes a chip. Ctrl V in the message box. | web: `composer/paste.ts`, `composer/Composer.tsx` | `paste`, `paste-desktop` |
| **Choose a model**<br>also: picker, model button, model selector | The model button and its picker: models grouped by fit, favorites, makers and the context size. The model button in the composer. | web: `picker`, `models/pick.ts`, `models/MakerMark.tsx`<br>server: `runtime/models.ts`, `runtime/chat-list.ts` | `picker-layout`, `model-pick`, `model-words`, `flicker`, `fit-still`, `mem-show`, `refusal-offer` |
| **Thinking pill** | Turns thinking on or off for this chat; greyed with the reason for a model that does not think. The composer toolbar, and Chat options. | web: `composer/Composer.tsx`<br>server: `settings/turn.ts` | `model-pick` |
| **Chat options** | A menu of the chat's switches: Thinking and Image. The sliders button in the composer toolbar. | web: `composer/Composer.tsx` | `image-count` |
| **Context used**<br>also: context meter | How much of the context the chat has used, as a ring, with the numbers on hover. The composer toolbar. | web: `composer/Composer.tsx`<br>server: `chat/window.ts` | `model-context`, `small-context` |
| **Composer note**<br>also: refusal note, refusal offer | One line above the composer when a send cannot go: what is wrong and the one way on. Above the composer. | web: `composer/RefusalNote.tsx`, `composer/Composer.tsx`<br>server: `fit/alternatives.ts`, `app/admit.ts` | `refusal-offer`, `small-context` |
| **Start screen**<br>also: new-chat heading, starter, setup icons | A new chat's mark and composer, with ringed icons for what is not set up yet (Library search, Image generation). A new thread before its first message. | web: `composer/starter.ts`, `app/App.tsx` | `start-mark` |

## Images in a chat

| Feature | What it is, and where | Code | Tests |
| --- | --- | --- | --- |
| **Image**<br>also: image choice, Generate image | Image mode: Send makes a picture from your words instead of a reply. The Image pill in the composer, the Add menu, or Chat options. | web: `image/image-choice.ts`, `composer/Composer.tsx`<br>server: `app/drawing.ts` | `image-look`, `image-picker` |
| **Choose an image model**<br>also: image presets, setups | The image picker: Defaults and Other models, each setup's sizes and whether it fits, and its download. The model button while Image is on. | web: `image/ImagePicker.tsx`, `image/image-picker.css`, `image/ImageMark.tsx`<br>server: `image/presets.ts`, `image/download.ts`, `image/handlers.ts`, `image/setups` | `image-picker`, `image-picker-menus`, `image-levels`, `image-look`, `image-two-threads`, `window-follow-ups` |
| **Pictures per send**<br>also: image count | How many pictures one send makes; each thread keeps its own count. The Thinking circle's place while Image is on. | web: `composer/Composer.tsx`<br>server: `app/handlers.ts` | `image-count` |
| **Image card**<br>also: image job | A picture in the thread: waiting, making, done, stopped or failed with Try again. The thread, where a send or a model's image call asked for one. | web: `thread/Thread.tsx`, `thread/image-links.ts`<br>server: `app/drawing.ts`, `chat/image-lifecycle.ts`, `chat/image-header.ts`, `image/service.ts`, `image/client.ts` | `image-card`, `image-batch`, `image-stopping`, `image-turn`, `image-two-threads`, `image-claims`, `text-call`, `streaming-integrity` |
| **Set up images**<br>also: image unset, engine setup | The pop-up that fetches the image engine and one setup in one click, or says why pictures cannot run here. Image while nothing is set up, Add › Set up image generation…, or Settings › Image generation. | web: `image/ImageUnset.tsx`<br>server: `image/setup.ts`, `image/engine.ts`, `image/installed.ts`, `image/linux-build.ts`, `image/linux-lock.ts`, `image/linux-lock-cpu.ts`, `image/own.ts`, `image/fixtures` | `image-setup`, `image-unset` |

## Pages

| Feature | What it is, and where | Code | Tests |
| --- | --- | --- | --- |
| **Page** | A page a reply wrote runs beside the chat in a locked frame; a chip reopens it and a stepper shows its versions. The panel beside the chat; the chip in the reply. | web: `pages`<br>server: `pages`, `chat/pages.ts`, `web/static.ts` | `pages`, `pages-lockdown`, `pages-long-chat`, `pages-desktop`, `composer-panel` |

## Models

| Feature | What it is, and where | Code | Tests |
| --- | --- | --- | --- |
| **Models › Installed**<br>also: ModelsPage, row menu | The models on this computer: set the default, copy a name, remove one. The Models icon in the sidebar footer (the Settings › Models section). | web: `models/Models.tsx`, `models/models.ts`, `models/models-actions.ts`, `models/models-rules.ts`<br>server: `runtime/handlers.ts`, `runtime/models.ts` | `models`, `mobile` |
| **Models › Download**<br>also: catalog, pull | Models to download, grouped by whether they fit this card, plus any model by its ollama.com name. The Download tab of Models, or Download models in the picker. | web: `models/ModelDownloads.tsx`, `models/models-actions.ts`<br>server: `runtime/catalog.ts`, `runtime/pull.ts`, `runtime/tiers.ts`, `runtime/recommended.ts`, `runtime/registry-size.ts` | `models`, `model-tiers`, `download-reload`, `no-models`, `download-queue`, `picker-layout` |
| **Speed**<br>also: TPS, tok/s | A model's tokens per second from its own replies, in the picker and in Models. Model rows, once a model has replied. | web: `models/model-speed.tsx`, `models/speed.ts`<br>server: `app/handlers.ts` | `model-speed`, `model-words` |
| **Memory mark** | What is in memory now, against the card, with other programs said once. Models and the Download tab; the model button. | web: `models/MemoryMark.tsx`<br>server: `runtime/load.ts`, `gpu/memory.ts` | `memory-mark`, `mem-show` |
| **Measure** | Grades a model on this computer, on a click, and keeps its score with the parts and checks behind it. A model row in Models, or its row menu on a phone. | web: `measure`<br>server: `measure` | `measure` |

## Usage

| Feature | What it is, and where | Code | Tests |
| --- | --- | --- | --- |
| **Usage** | Tokens in and out, replies and time generating, by range and model, as a chart. The Usage icon in the sidebar footer. | web: `usage`<br>server: `usage` | `usage` |

## Pictures

| Feature | What it is, and where | Code | Tests |
| --- | --- | --- | --- |
| **Pictures** | Every finished picture, newest first: a grid, a large view, search by prompt, Again in its thread. The Pictures icon in the sidebar footer. | web: `pictures`<br>server: `pictures` | `pictures` |

## Settings

| Feature | What it is, and where | Code | Tests |
| --- | --- | --- | --- |
| **Settings** | The sections down the left (a list on a phone) and Back to chat. The Settings icon in the sidebar footer. | web: `settings/Settings.tsx`, `settings/settings.ts`, `settings/settings-reads.ts`, `sidebar/Sidebar.tsx`, `app/App.tsx`<br>server: `settings` | `settings-switch`, `mobile`, `sb-hairline` |
| **General › Appearance** | Theme (dark, light, system) and Accent, the same in every open window. Settings › General. | web: `settings/Settings.tsx`, `lib/words/settings-rules.ts`<br>server: `settings/handlers.ts`, `settings/store.ts` | `theme`, `settings-s1`, `settings-two-windows` |
| **Instructions**<br>also: model settings, reply controls, system prompt | What every chat, or one model, is told, and its reply controls, sent to Ollama with each turn. Settings › Instructions. | web: `settings/Instructions.tsx`, `settings/instruction-draft.ts`<br>server: `settings/handlers.ts`, `settings/turn.ts` | `model-settings-ui`, `small-context` |
| **Tools**<br>also: imageTool (Make images), tools.shell (Run commands), sandbox | Whether a chat is offered tools, and which: Make images, Run commands and the Library. Settings › Tools. | web: `settings/Settings.tsx`<br>server: `chat/tools.ts`, `chat/shell.ts`, `chat/real-check.ts`<br>packages: `harness` | `settings-s1`, `run-commands`, `make-images-row`, `image-batch` |
| **Image generation**<br>also: images section, imageGen, ComfyUI | Generate images on or off, the ComfyUI address, the download folder and the processor setup row. Settings › Image generation. | web: `settings/Settings.tsx`<br>server: `image/module.ts`, `image/handlers.ts`, `image/controls.ts`, `image/files.ts`, `image/sources.ts`, `image/styles.ts`, `image/convert.ts`, `image/real-check.ts` | `settings-setup-row`, `image-card-later`, `image-ready` |
| **Runtime**<br>also: runtime mode, owner | Which Ollama the app uses (its own or the computer's), whether it runs, its address and models folder. Settings › Runtime. | web: `settings/Settings.tsx`, `runtime/words.tsx`<br>server: `runtime/handlers.ts`, `runtime/runtime.ts`, `runtime/switch.ts`, `runtime/probe.ts`, `runtime/real-discovery.ts`, `runtime/http.ts`, `runtime/services.ts`<br>packages: `runtime-files` | `runtime-wrong`, `mobile`, `no-ollama-version`, `sidebar-footer` |
| **Advanced** | GPU memory and its Default context, the Data folder, and Reset settings. Settings › Advanced. | web: `settings/Settings.tsx`<br>server: `settings/handlers.ts`, `fit/gpu-status.ts` | `settings-s2`, `fit-reason` |
| **Shortcuts** | The keyboard shortcuts, as a table. Settings › Shortcuts. | web: `settings/Settings.tsx` | none |

## Library

| Feature | What it is, and where | Code | Tests |
| --- | --- | --- | --- |
| **Library**<br>also: sources | Folders, files, databases and cloned repositories the model may read; read-only copies you add. Settings › Library; Add › Add to library… in the composer. | web: `settings/Settings.tsx`, `settings/library-rows.ts`<br>server: `sources/handlers.ts`, `sources/index.ts`, `sources/clone.ts`, `sources/git-worker.ts`, `sources/owned.ts`, `sources/anchored.ts`, `sources/activity.ts` | `library-truth`, `actions`, `flicker-swaps` |
| **Sample databases**<br>also: samples, imports | Databases to try, each downloaded in its own row, opened to its tables and the questions it can answer. Settings › Library. | web: `settings/LibraryImports.tsx`<br>server: `sources/samples.ts`, `sources/imports.ts`, `sources/sample-questions.json` | `library-defaults`, `library-imports-push` |

## First run and Ollama

| Feature | What it is, and where | Code | Tests |
| --- | --- | --- | --- |
| **First run**<br>also: Download your first model, Setting up Ollama | Finds or installs Ollama, offers one recommended model, downloads it and starts the chat. The first window on a new install, or when no chat model is installed. | web: `first-run`<br>server: `runtime/install.ts`, `runtime/manifest.ts`, `runtime/pick.ts`, `runtime/recommended.ts`<br>packages: `runtime-files` | `first-run`, `first-run-engine`, `first-run-failures`, `model-pick`, `no-models` |
| **Runtime banner** | One line over the chat when Ollama is installing, stalled, on the wrong port or stopped, with Retry. The top of the chat. | web: `runtime/Banner.tsx`, `runtime/install-stall.ts`, `runtime/words.tsx`<br>server: `runtime/handlers.ts` | `first-run-engine`, `runtime-wrong` |
| **Connecting… and Reconnecting** | What the window says when the server is slow to answer or gone, and how it comes back. The banner and controls, while the connection is down. | web: `lib/session/connection.ts`, `app/App.tsx`<br>server: `ws`<br>packages: `contracts` | `reconnect`, `actions` |

## Updates

| Feature | What it is, and where | Code | Tests |
| --- | --- | --- | --- |
| **General › Updates** | Version, Check for updates, Update, and the switches for automatic checks and every change. Settings › General. | web: `updates/SettingsUpdates.tsx`, `updates/update-state.ts`, `updates/updates.ts`<br>server: `update`<br>packages: `update` | `updates` |
| **Update icon** | The footer icon that turns into the one click to update, and asks once if a reply is running. The sidebar footer, on the desktop. | web: `updates/Updates.tsx`, `updates/update-install.ts`, `updates/update-work.ts` | `updates`, `sidebar-footer` |
| **Update note** | After an update, a note that says it worked or why it did not, until dismissed. The top of the window after a restart. | web: `updates/UpdateNote.tsx`<br>server: `update/module.ts` | `updates` |

## Voice

| Feature | What it is, and where | Code | Tests |
| --- | --- | --- | --- |
| **Dictate**<br>also: voice, whisper | Speak into the microphone; the words land in the draft at the cursor. The microphone in the composer, once a speech server is connected. | web: `voice/Voice.tsx`, `voice/voice-audio.ts`<br>server: `voice` | `voice` |
| **Talk mode** | Hold to talk, let go to send; the reply is read aloud. Settings › General › Voice to text, then the microphone. | web: `voice/talk.ts`, `voice/Voice.tsx`<br>server: `voice` | `voice` |
| **Voice to text**<br>also: whisperUrl, Speech server | The speech server's address, and Connect or Disconnect. Settings › General. | web: `voice/VoiceSettings.tsx`<br>server: `voice/module.ts`, `settings/handlers.ts` | `voice` |

## Phone

| Feature | What it is, and where | Code | Tests |
| --- | --- | --- | --- |
| **Phone**<br>also: web listener, Serve | The chat on a phone through Tailscale Serve: read, send, stop and switch models; nothing else. The tailnet address on a phone. | web: `lib/session/platform.ts`<br>server: `web` | `phone` |
| **Phone layout** | Below 1024 px: the drawer, bottom sheets, the Settings list, and nothing scrolls sideways. Any narrow window. | web: `app/sheet-focus.ts`, `app/App.tsx`, `sidebar/Sidebar.tsx` | `mobile` |

## Desktop app

| Feature | What it is, and where | Code | Tests |
| --- | --- | --- | --- |
| **Title bar** | The window's own title bar, with room kept for the native controls. The top of the desktop window. | web: `app/titlebar.ts`<br>desktop: `main.ts`, `launch.ts` | `titlebar` |
| **Copy and paste on the desktop** | The desktop's own clipboard and paste menu, which a page or a timer cannot read. Ctrl C, Ctrl V and the right-click menu in the desktop window. | web: `composer/paste.ts`<br>desktop: `clipboard.ts`, `native-paste.ts`, `context-menu.ts`, `keys.ts` | `copy-desktop`, `paste-desktop` |
| **Gates Local window** | The desktop app: starts the server, opens the window, opens links in your browser and pages in their own window. The app's launcher. | web: `app/main.tsx`, `app/screen-loaders.ts`, `app/screens.tsx`<br>server: `main.ts`, `index.ts`<br>desktop: `preload.ts`, `bridge.ts`, `links.ts`, `data-dir.ts`, `media-permission.ts`, `running.ts`, `linux-install.ts` | `pages-desktop`, `ready` |

## No screen

| Feature | What it is, and where | Code | Tests |
| --- | --- | --- | --- |
| **The queue** | One reply at a time per thread; a Stop holds what waits; a failed reply is retried once; every window sees the same queue. The server, behind Messages that wait. | web: `composer/chat.ts`, `composer/records.ts`<br>server: `app/queue-pump.ts`, `chat/replies.ts`, `chat/reply.ts`, `app/admit.ts` | `threads-queue`, `server-queue` |
| **One job on the GPU at a time** | Heavy GPU work goes through one lease; a chat and a picture wait for each other and whisper is never touched. The server, behind every send and picture. | server: `gpu` | `threads-image`, `stop-others` |
| **Model loading** | One record of what is loaded: New thread follows it, a second pick joins its one load, the load is a ring on Send. The server; the ring on Send and the composer's load bar. | web: `composer/LoadBar.tsx`, `lib/store/load-times.ts`<br>server: `runtime/load.ts`, `gpu/memory.ts`, `gpu/gate.ts` | `load-follow`, `thought-load` |
| **Fit**<br>also: fit table, FitBasis, verdict | Whether a model at a context fits the free memory measured now; every verdict on screen comes from this one table. The server; the verdicts in the picker, Models, first run and Settings. | web: `fit/fit-table.ts`<br>server: `fit`<br>packages: `contracts` | `fit-table`, `fit-card`, `fit-still` |
| **Memory details**<br>also: fit panel, GPU panel, FitPanel | The GPU memory panel: what a model at a context uses, what is in the way, and the sizes that fit. Memory details on a picker row, a model row or the composer note. | web: `fit/FitPanel.tsx`, `fit/fit-actions.ts`<br>server: `fit/estimate.ts`, `fit/off-card.ts`, `runtime/models.ts` | `fit-reason`, `model-context`, `refusal-offer` |
| **A small context window** | A chat longer than the model's context sends its newest turns; a message that alone will not fit is refused in a sentence. The server, on every send. | server: `chat/window.ts` | `small-context` |
| **Saved threads**<br>also: thread store | Every thread is saved as it streams and survives a restart; a cut-off reply stays, marked interrupted. The server's thread store. | server: `threads`, `app/handlers.ts`, `app/errors.ts`, `app/types.ts`, `shutdown.ts` | `reconnect`, `stop-retry` |
| **Every window agrees**<br>also: ORDERED_DOMAINS, sync, revisions | Settings, models, the Library, updates, images, the chat list and each chat carry a number on every answer, and a window applies only what is newer. The socket between server and window. | web: `lib/session/server-state.ts`<br>server: `ws`, `app.ts`<br>packages: `contracts` | `settings-two-windows`, `two-clients`, `threads-numbered` |
| **Installing an update** | An installed copy checks the signed release list, downloads, verifies and swaps itself, never removing the program that runs. The desktop app and server, after Update. | server: `update/installed`, `update/automatic.ts`, `update/published.ts`<br>desktop: `installed-update`, `update-control.ts`, `update-launch.ts`, `update-relaunch.ts`, `supervisor.ts`, `supervisor-state.ts`, `server-failure.ts`, `status-page.ts`<br>packages: `update` | none |
| **Machine setup plan** | Read this machine and plan models for it, for a setup run by an agent; on the wire, with no handler yet. Not built yet (see the roadmap). | packages: `contracts` | none |

## Across the app

| Feature | What it is, and where | Code | Tests |
| --- | --- | --- | --- |
| **Whole on the first frame**<br>also: flicker audit, placeholders, data-skel | Every surface shows its full shape on its first frame: nothing arrives late, moves or blinks. Every screen (docs/design.md). | web: `lib/ui/ui.tsx` | `flicker-audit`, `flicker-swaps`, `flicker`, `settings-cards-desktop` |
| **Pop-up** | Settings, Models and Usage open in one box of one size over the dimmed chat, which comes back as it was. The sidebar footer's Settings, Models and Usage. | web: `lib/ui/Panel.tsx`, `app/App.tsx` | `popups`, `settings-hides-chat`, `usage` |
| **Reload window**<br>also: error boundary | A screen that fails to draw recovers in place, keeps the draft, and offers Reload window if that fails too. Wherever a screen broke. | web: `app/ErrorBoundary.tsx` | `error-boundary` |
| **Speed checks** | Timed journeys (start, send, switch threads, paste, voice, queue) compared between two builds; informational. `pnpm perf:compare`; the e2e perf spec. |  | `perf`, `test/perf/journeys`, `test/perf/priority`, `test/perf/next` |
| **Bug finder** | Walks every screen and control looking for what moves, arrives late, says a thing twice or does nothing. `test/finder/`. |  | `test/finder/walk` |
| **Screenshots** | Pictures of each screen and Settings section for review and the README. `pnpm e2e:shots`, `pnpm shots:readme`. |  | `shots`, `readme-shots` |
| **A real model** | The built app against a real Ollama and a tiny model: stream, Stop, recall and a restart. `GATES_REAL_SMOKE=1` on a test machine. |  | `real-smoke` |

## Shared

Window folders every feature uses:

- `lib/session`: the connection and the calls every screen makes.
- `lib/store`: the one store and the saved drafts.
- `lib/ui`: the controls, icons, pop-up frame and placeholders.
- `lib/words`: words and number formats every screen shares.
