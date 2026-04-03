import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e/tests",
  outputDir: "./e2e/test-results",
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 1,
  workers: process.env.CI ? 1 : undefined,
  reporter: "html",
  timeout: 30_000,

  use: {
    baseURL: "http://localhost:3004",
    trace: "on-first-retry",
  },

  webServer: [
    {
      command: "pnpm dev:server",
      port: 3001,
      reuseExistingServer: true,
      cwd: "../..",
    },
    {
      command: "pnpm dev",
      port: 3004,
      reuseExistingServer: true,
    },
  ],

  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
});
