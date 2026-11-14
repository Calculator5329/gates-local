// The chat model list that arrives with the update check (models.json beside
// release.json, signed with the release key): used only when it verifies,
// holds together and is newer than the list in use; kept in the data folder
// and checked again on start; never a change to the update check's verdict.
import fs from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { CHAT_MODELS, type ChatModels } from "@gates-local/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { signManifest } from "../release-manifest.ts";
import { FEED_LIMITS, type Fetched, type Get } from "./feed.ts";
import { createInstalledUpdateModule } from "./module.ts";
import { createModelLists, encodeModelsFile, type ListOutcome, MODELS_DIR, MODELS_FILE, MODELS_SIGNATURE_FILE, type ModelListsDeps } from "./models-list.ts";
import { BASE, LIST_URL, memoryFeed, MODELS_SIG_URL, MODELS_URL, releaseKey, SIG_URL, signedList } from "./testing.ts";

const key = releaseKey();
const made: string[] = [];
afterEach(() => { for (const dir of made.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });

/** A data folder under ~/.cache, removed after the test. */
function dataDir(): string {
  const cache = path.join(homedir(), ".cache");
  fs.mkdirSync(cache, { recursive: true });
  const dir = fs.mkdtempSync(path.join(cache, "models-list-test-"));
  made.push(dir);
  return dir;
}

const NEW_MODEL = "newmodel4:7b";
/** The built-in list at revision, with one model the built-in list does not name. */
function chatAt(revision: number): Record<string, unknown> {
  return { ...CHAT_MODELS, revision, models: [...CHAT_MODELS.models, { name: NEW_MODEL, label: "Newmodel 4 7B", purpose: "Brand new answers", downloadBytes: 5_000_000_000 }] };
}
function signed(chat: unknown, o: { schema?: number; by?: typeof key } = {}): { list: Buffer; sig: Buffer } {
  const list = encodeModelsFile(chat, o.schema ?? 1);
  return { list, sig: signManifest(list, (o.by ?? key).privateKey) };
}

/** A copy's list holder, starting from the built-in list at builtIn. */
function holder(builtIn = 1) {
  let list: ChatModels = { ...CHAT_MODELS, revision: builtIn };
  return { inUse: () => list, use: vi.fn((next: ChatModels) => { list = next; }) };
}

function lists(o: { dir?: string; get?: Get; keys?: readonly string[]; held?: ReturnType<typeof holder> } = {}) {
  const held = o.held ?? holder();
  const log = vi.fn();
  const feed = memoryFeed();
  const deps: ModelListsDeps = { dataDir: o.dir ?? dataDir(), base: BASE, keys: o.keys ?? [key.publicKey], get: o.get ?? feed.get, inUse: held.inUse, use: held.use, log };
  return { lists: createModelLists(deps), feed, held, log, dir: deps.dataDir };
}
const serve = (feed: ReturnType<typeof memoryFeed>, files: { list: Buffer; sig?: Buffer }) => {
  feed.answer(MODELS_URL, { kind: "ok", bytes: files.list });
  feed.answer(MODELS_SIG_URL, files.sig === undefined ? { kind: "missing" } : { kind: "ok", bytes: files.sig });
};
const names = (l: ChatModels) => l.models.map((m) => m.name);
const refresh = (l: ReturnType<typeof lists>): Promise<ListOutcome> => l.lists.refresh(new AbortController().signal);

describe("a list from the release page", () => {
  it("a verified newer list is used after the check, and kept with its signature", async () => {
    const l = lists();
    const files = signed(chatAt(2));
    serve(l.feed, files);
    expect(await refresh(l)).toEqual({ kind: "used", revision: 2 });
    expect(names(l.held.inUse())).toContain(NEW_MODEL);
    expect(l.feed.reads).toEqual([MODELS_URL, MODELS_SIG_URL]);
    expect(fs.readFileSync(path.join(l.dir, MODELS_DIR, MODELS_FILE))).toEqual(files.list);
    expect(fs.readFileSync(path.join(l.dir, MODELS_DIR, MODELS_SIGNATURE_FILE))).toEqual(files.sig);
  });

  it("an unsigned list is not used", async () => {
    const l = lists();
    serve(l.feed, { list: signed(chatAt(2)).list });
    expect((await refresh(l)).kind).toBe("refused");
    expect(l.held.use).not.toHaveBeenCalled();
    expect(fs.existsSync(path.join(l.dir, MODELS_DIR))).toBe(false);
  });

  it("a list signed by another key is not used", async () => {
    const l = lists();
    serve(l.feed, signed(chatAt(2), { by: releaseKey() }));
    expect((await refresh(l)).kind).toBe("refused");
    expect(l.held.use).not.toHaveBeenCalled();
  });

  it("a list whose signature is for other bytes is not used", async () => {
    const l = lists();
    const good = signed(chatAt(2));
    serve(l.feed, { list: Buffer.from(good.list.toString("utf8").replace("Brand new answers", "Brand bad answers")), sig: good.sig });
    expect((await refresh(l)).kind).toBe("refused");
    expect(l.held.use).not.toHaveBeenCalled();
  });

  it("an older or equal revision is not used", async () => {
    const l = lists({ held: holder(5) });
    serve(l.feed, signed(chatAt(4)));
    expect(await refresh(l)).toEqual({ kind: "not-newer", revision: 4, inUse: 5 });
    serve(l.feed, signed(chatAt(5)));
    expect(await refresh(l)).toEqual({ kind: "not-newer", revision: 5, inUse: 5 });
    expect(l.held.use).not.toHaveBeenCalled();
  });

  it("an unknown schema is not used, nor a list that does not hold together", async () => {
    const l = lists();
    serve(l.feed, signed(chatAt(2), { schema: 2 }));
    expect((await refresh(l)).kind).toBe("refused");
    serve(l.feed, signed({ ...chatAt(2), format: 2 }));
    expect((await refresh(l)).kind).toBe("refused");
    serve(l.feed, signed({ ...chatAt(2), example: "not-listed:1b" }));
    expect((await refresh(l)).kind).toBe("refused");
    expect(l.held.use).not.toHaveBeenCalled();
  });

  it("a body over the limit is dropped, read with the models limit", async () => {
    const asked: number[] = [];
    const big = Buffer.alloc(FEED_LIMITS.modelsBytes + 1, 0x20);
    // As the real read does: a body past maxBytes is never kept.
    const get: Get = (url, max) => {
      asked.push(max);
      const body = url.href === MODELS_URL ? big : Buffer.from("x");
      return Promise.resolve<Fetched>(body.length > max ? { kind: "too-large" } : { kind: "ok", bytes: body });
    };
    const l = lists({ get });
    expect((await refresh(l)).kind).toBe("refused");
    expect(asked).toEqual([FEED_LIMITS.modelsBytes]);
    expect(l.held.use).not.toHaveBeenCalled();
  });

  it("a missing list is silent: nothing used, nothing logged", async () => {
    const l = lists();
    l.feed.answer(MODELS_URL, { kind: "missing" });
    expect(await refresh(l)).toEqual({ kind: "missing" });
    expect(l.feed.reads).toEqual([MODELS_URL]);
    expect(l.log).not.toHaveBeenCalled();
    expect(l.held.use).not.toHaveBeenCalled();
  });

  it("a refused list is logged once, not at every hourly check", async () => {
    const l = lists();
    serve(l.feed, signed(chatAt(2), { by: releaseKey() }));
    await refresh(l);
    await refresh(l);
    expect(l.log).toHaveBeenCalledTimes(1);
  });
});

describe("the kept list", () => {
  it("survives a restart with no network", async () => {
    const first = lists();
    serve(first.feed, signed(chatAt(2)));
    expect((await refresh(first)).kind).toBe("used");
    // The next start: a fresh holder at the built-in list, no feed at all.
    const again = lists({ dir: first.dir });
    expect(again.lists.loadStored()).toEqual({ kind: "used", revision: 2 });
    expect(names(again.held.inUse())).toContain(NEW_MODEL);
  });

  it("a tampered kept file is refused on start, and the built-in list stays", async () => {
    const first = lists();
    serve(first.feed, signed(chatAt(2)));
    await refresh(first);
    const file = path.join(first.dir, MODELS_DIR, MODELS_FILE);
    fs.writeFileSync(file, fs.readFileSync(file, "utf8").replace("Brand new answers", "Brand bad answers"));
    const again = lists({ dir: first.dir });
    expect(again.lists.loadStored().kind).toBe("refused");
    expect(again.held.use).not.toHaveBeenCalled();
    expect(again.log).toHaveBeenCalledTimes(1);
  });

  it("a newer app ignores an older kept list", async () => {
    const first = lists();
    serve(first.feed, signed(chatAt(2)));
    await refresh(first);
    const newer = lists({ dir: first.dir, held: holder(3) });
    expect(newer.lists.loadStored()).toEqual({ kind: "not-newer", revision: 2, inUse: 3 });
    expect(newer.held.use).not.toHaveBeenCalled();
  });

  it("no kept list on a first start is silent", () => {
    const l = lists();
    expect(l.lists.loadStored()).toEqual({ kind: "missing" });
    expect(l.log).not.toHaveBeenCalled();
  });
});

function copy(feed: ReturnType<typeof memoryFeed>, l: ReturnType<typeof lists>) {
  return createInstalledUpdateModule({
    version: "1.2.3", platform: "linux", arch: "x64",
    feed: { base: BASE, page: `${BASE.href}/latest`, keys: [key.publicKey], allowLoopbackHttp: false },
    dataDir: l.dir, automatic: { enabled: () => false, onChange: () => () => undefined }, keep: () => [],
    get: feed.get, models: l.lists, now: () => 1_000,
  });
}

describe("with the hourly check", () => {

  it("reads the list after release.json verified, and the verdict is the check's own", async () => {
    const l = lists();
    serve(l.feed, signed(chatAt(2), { by: releaseKey() }));
    l.feed.serve(signedList("1.2.3", ["linux"], key.privateKey));
    const module = copy(l.feed, l);
    expect(await module.check()).toMatchObject({ state: "up-to-date" });
    expect(l.feed.reads).toEqual([LIST_URL, SIG_URL, MODELS_URL, MODELS_SIG_URL]);
    await module.close();
  });

  it("uses a newer list that arrives with the check", async () => {
    const l = lists();
    serve(l.feed, signed(chatAt(2)));
    l.feed.serve(signedList("1.2.3", ["linux"], key.privateKey));
    const module = copy(l.feed, l);
    await module.check();
    expect(names(l.held.inUse())).toContain(NEW_MODEL);
    await module.close();
  });

  it("does not read the list when release.json failed its signature", async () => {
    const l = lists();
    serve(l.feed, signed(chatAt(2)));
    l.feed.serve(signedList("1.3.0", ["linux"], releaseKey().privateKey));
    const module = copy(l.feed, l);
    expect(await module.check()).toMatchObject({ state: "cannot-check", reason: "bad-signature" });
    expect(l.feed.reads).toEqual([LIST_URL, SIG_URL]);
    expect(l.held.use).not.toHaveBeenCalled();
    await module.close();
  });

  it("reads the kept list when the module starts", async () => {
    const first = lists();
    serve(first.feed, signed(chatAt(2)));
    await refresh(first);
    const again = lists({ dir: first.dir });
    const module = copy(again.feed, again);
    expect(names(again.held.inUse())).toContain(NEW_MODEL);
    await module.close();
  });
});
