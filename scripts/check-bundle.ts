import { fileURLToPath } from "node:url";
import { bundleSizeWarnings, bundleSize } from "../test/bundle-size.ts";

const size = bundleSize(fileURLToPath(new URL("../apps/web/dist", import.meta.url)));
console.log(`[bundle] gzip KiB: entry JS ${size.entryJs.toFixed(3)}, total JS ${size.totalJs.toFixed(3)}, startup CSS ${size.startupCss.toFixed(3)}, total CSS ${size.totalCss.toFixed(3)}`);
for (const warning of bundleSizeWarnings(size)) console.warn(`[bundle] warning: ${warning}`);
