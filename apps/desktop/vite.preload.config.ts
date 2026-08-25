import { builtinModules } from "node:module";
import { defineConfig } from "vite";
import { resolve } from "node:path";

export default defineConfig({
  build: {
    outDir: resolve(import.meta.dirname, "dist/preload"),
    emptyOutDir: true,
    lib: {
      entry: resolve(import.meta.dirname, "src/preload/preload.ts"),
      formats: ["cjs"],
      fileName: () => "preload.cjs",
    },
    rollupOptions: {
      external: ["electron", ...builtinModules, ...builtinModules.map((name) => `node:${name}`)],
    },
  },
});
