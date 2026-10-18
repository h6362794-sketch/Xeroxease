import { defineConfig } from "vitest/config";
import path from "path";

export default defineConfig({
  // tsconfig keeps `jsx: preserve` for Next.js. Tests that import a component (rendered with
  // react-dom/server) need the automatic runtime, or vite cannot parse the .tsx source.
  oxc: { jsx: { runtime: "automatic" } },
  test: {
    include: ["tests/**/*.test.ts"],
    environment: "node",
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
});
