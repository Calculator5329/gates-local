import { describe, expect, it } from "vitest";
import { type Sized, dayLabel, layoutSheet, rowsIn, yOf } from "./pictures-layout.ts";

const now = new Date(2026, 10, 16, 12).getTime();
const at = (y: number, m: number, d: number, h = 12) => new Date(y, m - 1, d, h).getTime();
const size = { width: 1000, target: 180, gap: 6, dayH: 44 };
/** A 16:9 picture finished at `doneAt`: 320 px wide at the target height. */
const wide = (doneAt: number): Sized => ({ width: 1600, height: 900, doneAt });

describe("the contact sheet", () => {
  it("names a day Today, Yesterday, its weekday this month, its month this year, and its year before", () => {
    expect(dayLabel(at(2026, 11, 16, 8), now)).toBe("Today");
    expect(dayLabel(at(2026, 11, 15, 23), now)).toBe("Yesterday");
    expect(dayLabel(at(2026, 11, 3), now)).toBe("Tue 3");
    expect(dayLabel(at(2026, 10, 12), now)).toBe("Mon 12 Oct");
    expect(dayLabel(at(2025, 10, 12), now)).toBe("12 Oct 2025");
  });

  it("closes a row once it is as wide as the sheet and stretches it to end at the edge; a day's last row keeps the target height", () => {
    const today = at(2026, 11, 16, 9);
    const sheet = layoutSheet([1, 2, 3, 4, 5].map(() => wide(today)), size, now);
    const [day, full, last] = sheet.rows;
    expect(day).toMatchObject({ kind: "day", y: 0, h: 44, label: "Today" });
    if (full?.kind !== "tiles" || last?.kind !== "tiles") throw new Error("Expected two rows of tiles");
    expect(full.tiles.map(t => t.index)).toEqual([0, 1, 2, 3]);
    expect(full.h).toBeLessThan(180);
    const end = full.tiles.at(-1);
    expect(end && end.x + end.w).toBe(1000);
    expect(last).toMatchObject({ y: 44 + full.h + 6, h: 180 });
    expect(last.tiles).toEqual([{ index: 4, x: 0, w: 320 }]);
    expect(sheet.height).toBe(last.y + 180 + 6);
  });

  it("draws only the rows that cross the window, a row cut by its top edge included", () => {
    const days = [16, 16, 16, 16, 16, 15, 15, 14, 14, 14, 14, 14, 3];
    const sheet = layoutSheet(days.map(d => wide(at(2026, 11, d, 9))), size, now);
    for (const [top, bottom] of [[0, 100], [60, 61], [100, 500], [250, 900], [sheet.height - 10, sheet.height + 500]] as const) {
      const crossing = sheet.rows.filter(r => r.y + r.h >= top && r.y <= bottom);
      expect(crossing.length, `${top}-${bottom}`).toBeGreaterThan(0);
      expect(rowsIn(sheet, top, bottom), `${top}-${bottom}`).toEqual(crossing);
    }
  });

  it("says where a picture sits by its row's top, and nothing for a picture not laid out", () => {
    const today = at(2026, 11, 16, 9);
    const sheet = layoutSheet([1, 2, 3, 4, 5].map(() => wide(today)), size, now);
    const rows = sheet.rows.filter(r => r.kind === "tiles");
    expect(yOf(sheet, 2)).toBe(rows[0]?.y);
    expect(yOf(sheet, 4)).toBe(rows[1]?.y);
    expect(yOf(sheet, 99)).toBeUndefined();
  });
});
