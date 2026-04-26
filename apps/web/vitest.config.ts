import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import path from "node:path";

export default defineConfig({
  plugins: [react()],
  test: {
    globals: true,
    environment: "jsdom",
    setupFiles: ["./src/test-setup.ts"],
    include: ["src/**/*.test.ts", "src/**/*.test.tsx"],
    // jsdom + RTL cold-import is heavy; under parallel runs the first
    // test of a file can brush the 5s default (2026-04-27 — adding new
    // components pulled several previously-fine tests over the cliff
    // under parallelization, even though every one passes in isolation).
    // 15s is generous for pure-unit work and does not mask real bugs.
    testTimeout: 15_000,
    hookTimeout: 15_000,
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
      "@workflow-control/shared": path.resolve(__dirname, "../../packages/shared/src/index.ts"),
    },
  },
});
