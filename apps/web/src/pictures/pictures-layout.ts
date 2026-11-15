// Pictures' contact sheet: day headers, then justified rows at each picture's true shape.
// Every row's height comes from the pictures' sizes alone, so the sheet's whole layout is
// known before a thumbnail arrives: nothing moves as they land, and only the rows on screen
// are drawn.

export interface Sized { readonly width: number; readonly height: number; readonly doneAt: number }

export interface Tile { readonly index: number; readonly x: number; readonly w: number }
export type Row =
  | { readonly kind: "day"; readonly y: number; readonly h: number; readonly label: string }
  | { readonly kind: "tiles"; readonly y: number; readonly h: number; readonly tiles: readonly Tile[] };

export interface Sheet { readonly rows: readonly Row[]; readonly height: number }

export interface SheetSize {
  readonly width: number;
  /** A full row's height before it is stretched to the width; a day's last row keeps it. */
  readonly target: number;
  readonly gap: number;
  readonly dayH: number;
}

const DAY = 86_400_000;
const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function startOfDay(ms: number): number {
  const d = new Date(ms);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/** "Today", "Yesterday", "Wed 12" this month, "Wed 12 Oct" this year, "12 Oct 2025" before. */
export function dayLabel(ms: number, now = Date.now()): string {
  const day = startOfDay(ms);
  const today = startOfDay(now);
  if (day === today) return "Today";
  if (day === startOfDay(today - DAY / 2)) return "Yesterday";
  const d = new Date(ms);
  const n = new Date(now);
  const wd = WEEKDAYS[d.getDay()] ?? "";
  const mo = MONTHS[d.getMonth()] ?? "";
  if (d.getFullYear() !== n.getFullYear()) return `${d.getDate()} ${mo} ${d.getFullYear()}`;
  if (d.getMonth() !== n.getMonth()) return `${wd} ${d.getDate()} ${mo}`;
  return `${wd} ${d.getDate()}`;
}

/** Tiles laid left to right at height h, the last one ending exactly at `right` when the row is full. */
function place(items: readonly Sized[], first: number, count: number, h: number, gap: number, right: number | null): Tile[] {
  const tiles: Tile[] = [];
  let x = 0;
  for (let k = 0; k < count; k++) {
    const p = items[first + k]!;
    const end = k === count - 1 && right !== null ? right : Math.round(x + (p.width / p.height) * h);
    tiles.push({ index: first + k, x, w: Math.max(1, end - x) });
    x = end + gap;
  }
  return tiles;
}

/** The whole sheet for pictures newest first. */
export function layoutSheet(items: readonly Sized[], size: SheetSize, now = Date.now()): Sheet {
  const { width, target, gap, dayH } = size;
  const rows: Row[] = [];
  if (width <= 0) return { rows, height: 0 };
  let y = 0;
  let i = 0;
  while (i < items.length) {
    const label = dayLabel(items[i]!.doneAt, now);
    rows.push({ kind: "day", y, h: dayH, label });
    y += dayH;
    let start = i;
    let ratio = 0;
    // the day's pictures, a row at a time: a row closes once it is at least as wide as the sheet at the target height
    while (i < items.length && (i === start || dayLabel(items[i]!.doneAt, now) === label)) {
      const p = items[i]!;
      ratio += p.width / p.height;
      i++;
      const n = i - start;
      const nextSameDay = i < items.length && dayLabel(items[i]!.doneAt, now) === label;
      if (ratio * target + gap * (n - 1) >= width) {
        const h = Math.max(1, Math.round((width - gap * (n - 1)) / ratio));
        rows.push({ kind: "tiles", y, h, tiles: place(items, start, n, h, gap, width) });
        y += h + gap;
        start = i;
        ratio = 0;
      } else if (!nextSameDay) {
        rows.push({ kind: "tiles", y, h: target, tiles: place(items, start, n, target, gap, null) });
        y += target + gap;
        start = i;
        ratio = 0;
      }
      if (!nextSameDay) break;
    }
  }
  return { rows, height: y };
}

/** The rows that cross [top, bottom], by binary search on y. */
export function rowsIn(sheet: Sheet, top: number, bottom: number): readonly Row[] {
  const { rows } = sheet;
  let lo = 0;
  let hi = rows.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    const r = rows[mid]!;
    if (r.y + r.h < top) lo = mid + 1;
    else hi = mid;
  }
  const out: Row[] = [];
  for (let k = lo; k < rows.length && rows[k]!.y <= bottom; k++) out.push(rows[k]!);
  return out;
}

/** Where a picture sits: its row's y, or undefined when it is not laid out. */
export function yOf(sheet: Sheet, index: number): number | undefined {
  for (const r of sheet.rows) if (r.kind === "tiles" && r.tiles.some((t) => t.index === index)) return r.y;
  return undefined;
}
