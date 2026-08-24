import { defineConfig } from "vite";
import { fileURLToPath } from "node:url";

const here = (p: string) => fileURLToPath(new URL(p, import.meta.url));

export default defineConfig({
  root: here("."),
  publicDir: here("../fixtures"),
  resolve: { alias: { "@transform": here("../transform/src") } },
  server: { fs: { allow: [here("..")] } },
});
