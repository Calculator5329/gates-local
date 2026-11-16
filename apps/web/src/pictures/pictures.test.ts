import type { Picture, PictureList, PictureListParams } from "@gates-local/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createPictures } from "./pictures.ts";

const pic = (jobId: string): Picture => ({
  jobId, threadId: "t1", threadTitle: "Ships", prompt: `prompt ${jobId}`, width: 1600, height: 900,
  queuedAt: 1, doneAt: 2, bytes: 3, imagePath: `images/${jobId}.png`,
});
const page = (ids: readonly string[], more: Partial<PictureList> = {}): PictureList => ({ pictures: ids.map(pic), count: ids.length, ...more });

/** A list call held open until the test answers it. */
function held() {
  const calls: { params: PictureListParams; answer: (p: PictureList) => void; fail: () => void }[] = [];
  const list = vi.fn((params: PictureListParams) => new Promise<PictureList>((resolve, reject) => {
    calls.push({ params, answer: resolve, fail: () => reject(new Error("down")) });
  }));
  return { list, calls };
}
const ids = (s: ReturnType<typeof createPictures>) => s.get().pictures.map(p => p.jobId);
const settle = () => new Promise(r => setTimeout(r, 0));

afterEach(() => { vi.useRealTimers(); });

describe("the pictures list", () => {
  it("counts every picture the search matches, not only the pages in hand", async () => {
    const s = createPictures({ list: async () => page(["a", "b"], { count: 57, next: "c" }) });
    await s.enter();
    expect(s.get().count).toBe(57);
  });

  it("is loading until the first answer, says a failure, and is loading again on the next open", async () => {
    const { list, calls } = held();
    const s = createPictures({ list });
    expect(s.get().status).toBe("loading");
    const first = s.enter();
    calls[0]?.fail();
    await first;
    expect(s.get().status).toBe("error");
    const second = s.enter();
    expect(s.get().status).toBe("loading");
    calls[1]?.answer(page(["a"]));
    await second;
    expect(s.get().status).toBe("ready");
  });

  it("opens with the search cleared and stops waiting on a slow server at a second; the pictures land when it answers", async () => {
    vi.useFakeTimers();
    const { list, calls } = held();
    const s = createPictures({ list });
    s.search("cat");
    let open = false;
    void s.enter().then(() => { open = true; });
    expect(s.get().q).toBe("");
    expect(calls.at(-1)?.params).toEqual({ limit: 200 });
    await vi.advanceTimersByTimeAsync(999);
    expect(open).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(open).toBe(true);
    calls.at(-1)?.answer(page(["a"]));
    await vi.advanceTimersByTimeAsync(0);
    expect(ids(s)).toEqual(["a"]);
  });

  it("drops an older first page that answers after a newer one", async () => {
    const { list, calls } = held();
    const s = createPictures({ list });
    const older = s.enter(), newer = s.enter();
    calls[1]?.answer(page(["new"]));
    await newer;
    calls[0]?.answer(page(["old"]));
    await older;
    expect(ids(s)).toEqual(["new"]);
  });

  it("asks for a search once typing pauses, with the last words typed", async () => {
    vi.useFakeTimers();
    const { list } = held();
    const s = createPictures({ list });
    s.search("c"); s.search("ca"); s.search("cat ");
    expect(s.get().q).toBe("cat ");
    await vi.advanceTimersByTimeAsync(149);
    expect(list).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(list).toHaveBeenCalledExactlyOnceWith({ limit: 200, q: "cat" });
  });

  it("a new first page keeps the picks still listed, else picks the newest", async () => {
    vi.useFakeTimers();
    const answers = [page(["a", "b", "c"]), page(["d", "c"]), page(["e", "f"])];
    const s = createPictures({ list: async () => answers.shift() ?? page([]) });
    await s.enter();
    s.select(["b", "c"]);
    s.search("x");
    await vi.advanceTimersByTimeAsync(150);
    expect(s.get().sel).toEqual(["c"]);
    s.search("y");
    await vi.advanceTimersByTimeAsync(150);
    expect(s.get().sel).toEqual(["e"]);
  });

  it("asks for the next page once at a time", async () => {
    const { list, calls } = held();
    const s = createPictures({ list });
    const open = s.enter();
    calls[0]?.answer(page(["a"], { next: "n1" }));
    await open;
    void s.more(); void s.more();
    expect(list).toHaveBeenCalledTimes(2);
    expect(calls[1]?.params).toEqual({ limit: 200, before: "n1" });
    calls[1]?.answer(page(["b"], { count: 2 }));
    await settle();
    expect(ids(s)).toEqual(["a", "b"]);
  });

  it("asks again for a next page that failed, on the next scroll to the end", async () => {
    const { list, calls } = held();
    const s = createPictures({ list });
    const open = s.enter();
    calls[0]?.answer(page(["a"], { next: "n1" }));
    await open;
    const failed = s.more();
    calls[1]?.fail();
    await failed;
    void s.more();
    expect(calls[2]?.params).toEqual({ limit: 200, before: "n1" });
  });

  it("puts a picture that finishes on top while the screen is on show, and reads nothing when it is not", async () => {
    const answers = [page(["a"]), page(["n", "a"])];
    const list = vi.fn(async () => answers.shift() ?? page([]));
    const s = createPictures({ list });
    await s.enter();
    await s.finished();
    expect(list).toHaveBeenCalledTimes(1);
    s.shown(true);
    await s.finished();
    expect(list).toHaveBeenLastCalledWith({ limit: 24 });
    expect(ids(s)).toEqual(["n", "a"]);
    expect(s.get().count).toBe(2);
    s.shown(false);
    await s.finished();
    expect(list).toHaveBeenCalledTimes(2);
  });
});
