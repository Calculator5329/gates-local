# The server process and its environment

`apps/server/src/main.ts` is the entry the desktop supervisor spawns
(the contract is in `apps/desktop/README.md`):

```
<electron or node> apps/server/src/main.ts --port <n> --data-dir <dir>
```

- The per-launch token comes in `GATES_LOCAL_SERVER_TOKEN`. Without it the
  server refuses to start.
- Once the socket listens it prints one `{"ready":true,"port":<n>}` line on
  stdout. Every log line goes to stderr.
- It exits on stdin EOF (the parent died), SIGTERM, SIGINT and SIGHUP.

`apps/server/test/server-env-doc.test.ts` checks that every
`GATES_LOCAL_*` name the server reads (in its own source and in the
update package it imports) has a row below, and that every row names
one it reads.

## Knobs

| Knob | What it does |
|---|---|
| `GATES_LOCAL_SERVER_TOKEN` | The per-launch token every client must present. |
| `GATES_LOCAL_ALLOWED_ORIGINS` | A comma list added to the dev web origins (the Vite client on 127.0.0.1:5187 and localhost:5187). The desktop app sets it to add `gates-local://app`. A `file://` page is refused. |
| `GATES_LOCAL_DESKTOP` | `1` when the desktop app supervises this server. Only then does the automatic update checker run; a browser-only server never fetches on a timer. |
| `GATES_LOCAL_OLLAMA_URL` | Treat this URL (`http://127.0.0.1:<port>`) as the system Ollama, and its port as the first of the app's own ports. Discover-only: never install, start or stop one. Settings › Runtime still applies: "app" first tries the copy this data dir's ownership record names, at its recorded port, then the pinned port and the nine after it, as it does on 11435..11444 without a pin. |
| `GATES_LOCAL_OLLAMA_REGISTRY` | Where a typed model's whole download size is read before Ollama has named all its files. Default `https://registry.ollama.ai`, the host Ollama downloads from. `off`, or a pinned `GATES_LOCAL_OLLAMA_URL` without this set, never asks, so tests reach no outside host. |
| `GATES_LOCAL_RUNTIME` | `discover-only`: never install, start or stop Ollama (tests). Runtime Retry looks again and starts nothing. |
| `GATES_LOCAL_OLLAMA_BINARY` | `none`: never look for an Ollama binary (app install, PATH), as on a machine with none, so tests do not depend on the host. Any other value is refused. |
| `GATES_LOCAL_NVIDIA_SMI` | The nvidia-smi command the fit check and the GPU status run. Default `nvidia-smi`. Tests point it at `test/fake-ollama/nvidia-smi.sh` on Linux and `nvidia-smi.ts` elsewhere; on Windows a `.ts` or `.js` script runs through this Node or Electron. |
| `GATES_LOCAL_MEMINFO` | The meminfo file the fit check reads. Default `/proc/meminfo`. The image presets read system memory from it when set, else from the OS. |
| `GATES_LOCAL_IMAGE_DOWNLOAD_ORIGIN` | Tests: image model downloads fetch from this http origin on this computer, never Hugging Face, and are checked against their pins only, not the app's records of each file's sha256. The e2e stack always sets it. |
| `GATES_LOCAL_COMFY_URL` | Tests: the ComfyUI address when Settings has none, in place of `http://127.0.0.1:8188`, and `comfyui.service` is never asked about. Every test launcher sets it (`test/e2e-env.test.ts`). |
| `GATES_LOCAL_IMAGE_ENGINE` | Tests: JSON `{manifest, layout, address, build?}`. Set up images installs this engine (an http origin on this computer, never the pinned release; with `build`, through the Linux build from the fake's uv and lock). The app's own ComfyUI is read at `address`, before it is installed the app reads `address` in place of `GATES_LOCAL_COMFY_URL`, and no systemd unit is looked for (`image/engine.ts` engineKnob). |
| `GATES_LOCAL_OFFER_ENGINE` | `1`: Set up images offers the real pinned engine although `ENGINE_OFFERED` is off, to try the real install before a release offers it (`image/engine.ts` engineOffered). Any other value is refused. |
| `GATES_LOCAL_UPDATE_TEST_ROOT` | Tests: the update check refuses to run git or pnpm in any folder outside this one (`src/update/guard.ts`). The e2e stack sets it. |
| `GATES_LOCAL_INSTALLED_VERSION` | The packaged desktop app's version. When set, Settings › Updates checks the signed release list (`src/update/installed/`) and the clone updater is never built, so updates start no git. |
| `GATES_LOCAL_UPDATE_FEED` | An https release page base in place of the public one. |
| `GATES_LOCAL_UPDATE_TEST_KEYS` | Test builds only (`resources/test-build.json` beside `resources/server/main.mjs`): extra release keys, and the feed may be loopback http. |
| `GATES_LOCAL_INSTALLED_RESTART` | Set by the desktop app: whether this installed copy can replace its own file (`yes`), or why not (`installed/module.ts` parseRestart). |
| `GATES_LOCAL_UPDATE_STARTUP_TOKEN` | Set on an installed copy's update start: every write waits until the watcher's result carries this token. Ignored when `GATES_LOCAL_INSTALLED_VERSION` is unset. |
| `GATES_LOCAL_UPDATE_TEST_FAULT` | Test builds only. `server-never-ready@<version>` keeps that version's server from printing ready, so an update to it goes back. First it raises the store's version by one, after the pre-migration copy, so going back has a store to restore, and it adds a settings key the older version does not know. `server-exits@<version>` makes that version's server exit at start, before it opens the store. `test/packaged/packaged-upgrade.ts` drives both. |
| `GATES_LOCAL_SEND_TIMES` | `1`: print, for each send, where its time went. |

## The phone listener

Off unless `GATES_LOCAL_WEB_LISTEN` is set (`src/web/`). With it set, a
missing or malformed other knob stops the start with exit 2.

| Knob | What it does |
|---|---|
| `GATES_LOCAL_WEB_LISTEN` | `unix:<absolute path>` for a second listener Tailscale Serve proxies to (`tailscale serve --bg --https=8456 unix:<path>`). Same handlers and pushes, no token. The socket is 0600 in a 0700 directory of this user's (made if missing), so only this user and root's tailscaled can open it. TCP values are refused. |
| `GATES_LOCAL_WEB_ORIGIN` | The exact public origin, e.g. `https://hub.example.ts.net:8456`. |
| `GATES_LOCAL_WEB_USER` | The one Tailscale-User-Login value admitted. |
| `GATES_LOCAL_WEB_ROOT` | The built web client to serve (`apps/web/dist`). |
| `GATES_LOCAL_WEB_PEERS` | Optional comma list of the phones' Tailscale addresses. When set, only those sources (Serve's X-Forwarded-For) are admitted. |

Serve stamps the owner's login on any dial from this machine to its own
Tailscale address, so a source that is one of this machine's addresses is
always refused. `GATES_LOCAL_WEB_PEERS` also covers what that check cannot
see, such as a userspace-networking tailscaled where no interface carries
the address.
