import { build } from "esbuild";
const alias = { "@transform": new URL("../transform/src", import.meta.url).pathname };
const common = {
  bundle: true, platform: "node", target: "node20", external: ["electron"], logLevel: "warning",
  alias,
};
await build({ ...common, entryPoints: ["app/src/main.ts"], outfile: "app/dist/main.mjs", format: "esm" });
await build({ ...common, entryPoints: ["app/src/preload.ts"], outfile: "app/dist/preload.cjs", format: "cjs" });
await build({ ...common, entryPoints: ["app/src/renderer.ts"], outfile: "app/dist/renderer.js", format: "iife", platform: "browser" });
// The selection overlay (STC-290) is its own window with its own, smaller
// bridge — it reads nothing and writes nothing, so it must not load the main
// window's preload.
await build({ ...common, entryPoints: ["app/src/overlay-preload.ts"], outfile: "app/dist/overlay-preload.cjs", format: "cjs" });
await build({ ...common, entryPoints: ["app/src/overlay.ts"], outfile: "app/dist/overlay.js", format: "iife", platform: "browser" });
console.log("app built -> app/dist/");
