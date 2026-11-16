// why: no image family ships a logo, so the tile shows letters as a chat maker's does
const SHORT: Readonly<Record<string, string>> = { sdxl: "XL", flux: "FX" };

export function ImageMark({ family }: { family: string }) {
  return <span className="maker-mark" aria-hidden="true">{SHORT[family] ?? family.slice(0, 2).toUpperCase()}</span>;
}
