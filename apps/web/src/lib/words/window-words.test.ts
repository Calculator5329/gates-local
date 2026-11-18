// The window's own sentences, one row each, from the pure functions that build them. A row pins
// the whole sentence a person reads, so a changed word, a dropped branch or a wrong number in any
// of them fails here even where a screen test only looks for part of it.
import { Fragment, createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, describe, expect, it, vi } from "vitest";
import type { FitMemory, ModelInfo, RuntimeStatus, Settings } from "@gates-local/contracts";
import { sizeOf } from "../../composer/refused-files.ts";
import { imageReason } from "../../composer/paste.ts";
import { cardLine } from "../../fit/fit-table.ts";
import { SANDBOX_OFF_SKIP, SANDBOX_UNKNOWN_SKIP, SERVER_REFUSED_SKIP } from "../../measure/measure-pages.ts";
import { NO_GPU_TEXT, count } from "./format.ts";

// external: the runtime words load the session, which writes to window as it starts
vi.stubGlobal("window", {});
afterAll(() => { vi.unstubAllGlobals(); });
const { FAIL_FALLBACK, PLACEHOLDER, failWhy, failWords, installStep, installWords, ownCopyNote, rtInfo, underTitle } = await import("../../runtime/words.tsx");

const GIB = 1024 ** 3;
const plain = (text: string | undefined | null) => text?.replaceAll(" ", " ");
const shown = (node: ReactNode) => renderToStaticMarkup(createElement(Fragment, null, node)).replace(/<[^>]+>/g, "").replaceAll("&#x27;", "'").replaceAll("&amp;", "&");

const runtime = (over: Partial<RuntimeStatus> = {}): RuntimeStatus => ({ state: "ready", owner: "external", baseUrl: "http://127.0.0.1:11434", ...over });
const settings = (over: Partial<Settings> = {}): Settings => ({ defaultNumCtx: 16384, thinking: true, theme: "dark", runtimeMode: "system", tools: true, imageGen: true, ...over });
const open = { kind: "open" } as const;
const model = (name: string, vision: boolean): ModelInfo => ({ name, digest: "d", sizeBytes: 1, modifiedAt: "2026-01-01T00:00:00Z", capabilities: vision ? ["completion", "vision"] : ["completion"] });

type Row = readonly [said: string, words: () => unknown, reads: unknown];

const SIZES: readonly Row[] = [
  ["an empty file", () => sizeOf(0), "0 B"],
  ["a file under 1 KB", () => sizeOf(500), "500 B"],
  ["a file one byte under 1 KB", () => sizeOf(1023), "1023 B"],
  ["a file of exactly 1 KB", () => sizeOf(1024), "1 KB"],
  ["a file of 1.5 KB, rounded", () => sizeOf(1536), "2 KB"],
  ["a file of 700 KB", () => sizeOf(700 * 1024), "700 KB"],
  ["a file of exactly 1 MB", () => sizeOf(1024 ** 2), "1.0 MB"],
  ["a file of 5.5 MB", () => sizeOf(5.5 * 1024 ** 2), "5.5 MB"],
];

const COUNTS: readonly Row[] = [
  ["one of a thing", () => count(1, "file"), "1 file"],
  ["none of a thing", () => count(0, "file"), "0 files"],
  ["two of a thing", () => count(2, "file"), "2 files"],
  ["two of a thing with its own plural", () => count(2, "child", "children"), "2 children"],
];

const memory = (over: Partial<Extract<FitMemory, { kind: "gpu" }>> = {}): FitMemory => ({ kind: "gpu", freeBytes: GIB, usableBytes: GIB, ...over });
const CARDS: readonly Row[] = [
  ["a computer with no card", () => cardLine({ kind: "cpu" }, undefined), "Runs in system memory"],
  ["a card that cannot be read", () => cardLine({ kind: "unreadable", detail: "nvidia-smi failed" }, undefined), "GPU reading unavailable"],
  ["a card whose size is not known yet", () => cardLine(memory(), undefined), ""],
  ["one card", () => plain(cardLine(memory(), 16 * GIB)), "16 GB GPU"],
  ["two cards", () => plain(cardLine(memory({ gpuCount: 2 }), 24 * GIB)), "2 GPUs, 24 GB"],
];

const FAILS: readonly Row[] = [
  ["a download that did not finish", () => failWords("download"), { title: "The Ollama download didn't finish", stat: "Download didn't finish" }],
  ["a download that failed its checksum", () => failWords("checksum"), { title: "The download couldn't be verified", stat: "Couldn't verify download" }],
  ["a full disk", () => failWords("disk"), { title: "Not enough disk space for Ollama", stat: "Not enough disk space" }],
  ["an install that failed", () => failWords("install"), { title: "Ollama didn't install", stat: "Didn't install" }],
  ["a start that failed", () => failWords("start"), { title: "Ollama didn't start", stat: "Didn't start" }],
  ["a failure that names no step", () => failWords(undefined), { title: "Ollama didn't start", stat: "Didn't start" }],
  ["a stopped download's next step", () => FAIL_FALLBACK.download, "Check the network, then retry."],
  ["a checksum failure's next step", () => FAIL_FALLBACK.checksum, "Download it again."],
  ["a full disk's next step", () => FAIL_FALLBACK.disk, "Free some space on this drive, then retry."],
  ["a failed install's next step", () => FAIL_FALLBACK.install, "Retry. If it fails again, install Ollama from ollama.com."],
  ["a failed start's next step", () => FAIL_FALLBACK.start, "Retry. If it still won't start, install Ollama from ollama.com."],
  ["a stopped download, under its title", () => underTitle("The Ollama download stopped at 0.6 of 1.5 GB (no data for 30 s).", "download"), "Stopped at 0.6 of 1.5 GB. Check the network, then retry."],
  // the checksum and its figures go to the details (data-why); the line says what to do
  ["a checksum failure, under its title", () => underTitle("The Ollama download didn't match its checksum. Nothing was installed.", "checksum"), "Download it again."],
  ["a checksum failure's details", () => failWhy("The Ollama download didn't match its checksum.", "checksum"), "The Ollama download didn't match its checksum."],
  // council climb-025 Q16: the line is plain words and a step; the raw detail is in the details
  ["a stopped download's details", () => failWhy("The Ollama download stopped at 0.6 of 1.5 GB.", "download"), "The Ollama download stopped at 0.6 of 1.5 GB."],
  ["a full disk, under its title", () => underTitle("The disk is full. Free 2 GB on this drive.", "disk"), "Free 2 GB on this drive."],
  ["a full disk with nothing more to say", () => underTitle("The disk is full.", "disk"), undefined],
  ["a failed start, under its title", () => underTitle("Ollama exited during startup.", "start"), "Ollama exited during startup."],
];

const PLACEHOLDERS: readonly Row[] = [
  ["the box while Ollama is ready", () => PLACEHOLDER.ready, "Ask anything…"],
  ["the box while Ollama installs", () => PLACEHOLDER.installing, "Ask anything…"],
  ["the box while Ollama starts", () => PLACEHOLDER.starting, "Chat starts when Ollama is running…"],
  ["the box with no Ollama", () => PLACEHOLDER.missing, "Install Ollama to start chatting"],
  // Council climb-025 Q16: "port" is the app's word, not the person's
  ["the box when something else holds the port", () => PLACEHOLDER.wrong, "Chat starts when Ollama answers…"],
  ["the box while Ollama is stopped", () => PLACEHOLDER.stopped, "Chat starts when Ollama is running…"],
  ["the box after Ollama failed", () => PLACEHOLDER.error, "Chat starts when Ollama is running…"],
  ["the box while the server is away", () => PLACEHOLDER.offline, "Chat starts when Gates Local reconnects…"],
];

const INSTALLS: readonly Row[] = [
  ["an install still downloading", () => installStep({ receivedBytes: 1, totalBytes: 2 }), "Downloading Ollama"],
  ["an install with all its bytes", () => installStep({ receivedBytes: 2, totalBytes: 2 }), "Unpacking Ollama"],
  ["no install under way", () => installWords(undefined), undefined],
  ["an install with all its bytes, and its size on disk", () => plain(installWords({ receivedBytes: 2 * GIB, totalBytes: 2 * GIB, diskBytes: 3 * GIB })), "2.0 GB downloaded · 3.0 GB on disk"],
];

const ON_PORT = { conn: open, runtime: runtime({ state: "missing", baseUrl: "http://127.0.0.1:5288" }) };
const OWN_COPY: readonly Row[] = [
  ["a ready Ollama", () => ownCopyNote({ conn: open, runtime: runtime({ busyPorts: ["11434"] }) }), ""],
  ["one other program on the usual port", () => ownCopyNote({ ...ON_PORT, runtime: runtime({ ...ON_PORT.runtime, busyPorts: ["11434"] }) }), "Something other than Ollama answers on port 11434, so Gates Local uses its own Ollama on port 5288."],
  ["other programs on two ports", () => ownCopyNote({ ...ON_PORT, runtime: runtime({ ...ON_PORT.runtime, busyPorts: ["11434", "11435", "5288"] }) }), "Something other than Ollama answers on ports 11434 and 11435, so Gates Local uses its own Ollama on port 5288."],
  ["the app's own copy picked in Settings", () => ownCopyNote({ ...ON_PORT, settings: settings({ runtimeMode: "app" }) }), "Gates Local uses its own Ollama on port 5288."],
  ["the system copy picked in Settings", () => ownCopyNote({ ...ON_PORT, settings: settings() }), ""],
];

const gear = (source: Parameters<typeof rtInfo>[0]) => { const { dot, text, tip } = rtInfo(source); return { dot, text: shown(text), tip }; };
const GEAR: readonly Row[] = [
  ["the app's own Ollama, ready", () => gear({ conn: open, runtime: runtime({ owner: "app" }) }), { dot: "ok", text: "Ollama · Gates Local", tip: "<b>Ready.</b> Gates Local's own copy. It starts with the app and stops when the app quits." }],
  ["a system Ollama, ready", () => gear({ conn: open, runtime: runtime() }), { dot: "ok", text: "Ollama · system", tip: "<b>Ready.</b> System install, started outside Gates Local. Gates Local uses it and never stops it." }],
  ["an install under way", () => gear({ conn: open, runtime: runtime({ state: "installing", owner: "app", install: { receivedBytes: 1, totalBytes: 2 } }) }), { dot: "run", text: "Downloading Ollama", tip: "" }],
  ["an install that stalled", () => gear({ conn: open, runtime: runtime({ state: "installing", owner: "app", install: { receivedBytes: 1, totalBytes: 2, stalled: true } }) }), { dot: "warn", text: "Download stalled", tip: "Open Settings › Runtime to retry." }],
  ["looking for a system Ollama", () => gear({ conn: open, runtime: runtime({ state: "starting", owner: "none" }) }), { dot: "run", text: "Looking for Ollama", tip: "Checking port 11434." }],
  ["starting the app's own Ollama", () => gear({ conn: open, runtime: runtime({ state: "starting", owner: "app", baseUrl: "http://127.0.0.1:5288" }) }), { dot: "run", text: "Starting Ollama", tip: "Waiting for the server on port 5288." }],
  ["no Ollama anywhere", () => gear({ conn: open, runtime: runtime({ state: "missing", owner: "none" }) }), { dot: "warn", text: "Ollama not installed", tip: "No Ollama install found. Gates Local can install its own copy." }],
  ["no Ollama, with the app's own copy picked", () => gear({ ...ON_PORT, settings: settings({ runtimeMode: "app" }) }), { dot: "warn", text: "Ollama not installed", tip: "No Ollama install found. Gates Local uses its own Ollama on port 5288." }],
  ["something else on the port", () => gear({ conn: open, runtime: runtime({ state: "wrong-service", owner: "none" }) }), { dot: "err", text: "Another program in its place", tip: "Something other than Ollama answers on port 11434." }],
  ["a stopped system Ollama", () => gear({ conn: open, runtime: runtime({ state: "stopped", owner: "none" }) }), { dot: "warn", text: "Ollama stopped", tip: "Nothing answers on port 11434. Start Ollama, then retry." }],
  ["a stopped copy of the app's own", () => gear({ conn: open, runtime: runtime({ state: "stopped", owner: "none", baseUrl: "http://127.0.0.1:5288" }), settings: settings({ runtimeMode: "app" }) }), { dot: "warn", text: "Ollama stopped", tip: "Gates Local uses its own Ollama on port 5288. It starts when Gates Local opens." }],
  ["a download that stopped", () => gear({ conn: open, runtime: runtime({ state: "error", owner: "none", failure: "download" }) }), { dot: "err", text: "The Ollama download didn't finish", tip: "Open Settings › Runtime for details and Retry." }],
  ["the server away", () => gear({ conn: { kind: "connecting" }, runtime: runtime() }), { dot: "run", text: "Reconnecting", tip: "The Gates Local server stopped answering. Trying again." }],
];

const VISION = [model("llama3", false), model("gemma3", true)];
const IMAGES: readonly Row[] = [
  ["a message with no images", () => imageReason(VISION, "llama3", []), null],
  ["images for a model that reads them", () => imageReason(VISION, "gemma3", ["data:image/png;base64,AA"]), null],
  ["images with no model picked and none that reads them", () => imageReason([model("llama3", false)], undefined, ["data:image/png;base64,AA"]), "The selected model cannot see images. Download a model that reads images, or remove the attachments."],
  ["images for a model that cannot see, with one that can", () => imageReason(VISION, "llama3", ["data:image/png;base64,AA"], tag => tag.toUpperCase()), "LLAMA3 cannot see images. Pick GEMMA3, which reads images, or remove the attachments."],
];

const FIXED: readonly Row[] = [
  ["no supported card", () => NO_GPU_TEXT, "No supported GPU was found (Gates Local reads NVIDIA cards). Replies are slower than on a GPU."],
  ["pages skipped with the sandbox off", () => SANDBOX_OFF_SKIP, "Pages were not run: Chromium's sandbox is off in this copy."],
  ["pages skipped with the sandbox unknown", () => SANDBOX_UNKNOWN_SKIP, "Pages were not run: this copy did not say whether Chromium's sandbox is on."],
  ["a page the server did not take", () => SERVER_REFUSED_SKIP, "The server did not take the page, so it was not run."],
];

const TABLE: Readonly<Record<string, readonly Row[]>> = {
  "a file's size": SIZES,
  "a count": COUNTS,
  "the card line": CARDS,
  "an Ollama failure": FAILS,
  "the message box": PLACEHOLDERS,
  "an Ollama install": INSTALLS,
  "the own-copy note": OWN_COPY,
  "the runtime gear": GEAR,
  "images the model cannot see": IMAGES,
  "a fixed sentence": FIXED,
};

for (const [what, rows] of Object.entries(TABLE)) {
  describe(`the window's words for ${what}`, () => {
    it.each(rows)("%s", (_said, words, reads) => {
      expect(words()).toEqual(reads);
    });
  });
}
