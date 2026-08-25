import { builtinModules } from "node:module";
import { defineConfig } from "vite";
import { resolve } from "node:path";

export default defineConfig({
  build: {
    outDir: resolve(import.meta.dirname, "dist/main"),
    emptyOutDir: true,
    lib: {
      entry: resolve(import.meta.dirname, "src/main/main.ts"),
      formats: ["es"],
      fileName: () => "main.js",
    },
    rollupOptions: {
      external: ["electron", ...builtinModules, ...builtinModules.map((name) => `node:${name}`)],
    },
  },
});
