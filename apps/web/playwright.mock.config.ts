import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e/tests-lifecycle",
  outputDir: "./e2e/test-results-lifecycle",
  fullyParallel: false,
  retries: 1,
  workers: 1,
  reporter: "html",
  timeout: 60_000,

  use: {
    baseURL: "http://localhost:3003",
    trace: "on-first-retry",
  },

  webServer: [
    {
      command: "MOCK_EXECUTOR=true MOCK_EXECUTOR_DELAY_MS=300 PORT=3002 pnpm dev:server",
      port: 3002,
      reuseExistingServer: false,
      timeout: 30_000,
      cwd: "../..",
    },
    {
      command: "NEXT_PUBLIC_API_URL=http://localhost:3002 pnpm --filter web exec next dev --turbopack -p 3003",
      port: 3003,
      reuseExistingServer: false,
      timeout: 60_000,
      cwd: "../..",
    },
  ],

  projects: [
    {
      name: "chromium-lifecycle",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
});
