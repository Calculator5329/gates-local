// The image models' mark, in the same tile as a chat model's maker mark. No image family has a
// bundled logo, so the tile carries the family's two letters, as Milo's does.
const SHORT: Readonly<Record<string, string>> = { sdxl: "XL", flux: "FX" };

export function ImageMark({ family }: { family: string }) {
  return <span className="maker-mark" aria-hidden="true">{SHORT[family] ?? family.slice(0, 2).toUpperCase()}</span>;
}
