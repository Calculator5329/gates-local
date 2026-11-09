import { fileURLToPath } from "node:url";
import { assertBundleBudget, bundleSize } from "../test/bundle-size.ts";

const size = bundleSize(fileURLToPath(new URL("../apps/web/dist", import.meta.url)));
console.log(`[bundle] gzip KiB: entry ${size.entryJs.toFixed(3)}, total ${size.totalJs.toFixed(3)}, CSS ${size.css.toFixed(3)}`);
assertBundleBudget(size);
