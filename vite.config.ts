import { defineConfig } from "vite";

export default defineConfig({
  // Use relative base so the build works under any GitHub Pages path
  // (https://<user>.github.io/<repo>/).
  base: "./",
  build: {
    target: "es2022",
    sourcemap: true,
  },
});
