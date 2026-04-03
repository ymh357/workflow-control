import { test as base, expect } from "@playwright/test";

const API_BASE = "http://localhost:3001";

interface CustomFixtures {
  apiBase: string;
  waitForServer: void;
}

export const test = base.extend<CustomFixtures>({
  apiBase: [API_BASE, { option: true }],

  waitForServer: [
    async ({}, use) => {
      const maxAttempts = 30;
      const interval = 1000;

      for (let i = 0; i < maxAttempts; i++) {
        try {
          const res = await fetch(`${API_BASE}/health/ready`);
          if (res.ok) {
            await use();
            return;
          }
        } catch {
          // server not ready yet
        }
        await new Promise((r) => setTimeout(r, interval));
      }

      throw new Error("Server did not become ready within 30s");
    },
    { auto: false },
  ],
});

export { expect };
