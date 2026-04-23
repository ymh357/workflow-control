import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import PipelinesPage from "./page";

describe("PipelinesPage", () => {
  const origFetch = global.fetch;

  beforeEach(() => {
    global.fetch = vi.fn();
  });
  afterEach(() => {
    global.fetch = origFetch;
  });

  it("renders empty state when list is empty", async () => {
    (global.fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ok: true,
      json: async () => ({ ok: true, pipelines: [] }),
    });
    render(<PipelinesPage />);
    await waitFor(() => {
      expect(screen.getByText(/no pipelines/i)).toBeDefined();
    });
  });

  it("renders one row per pipeline with a link to the editor", async () => {
    (global.fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        ok: true,
        pipelines: [
          { name: "pr-description-generator", latestVersion: "a1b2c3d4e5f6a1b2c3d4", latestCreatedAt: 1_700_000_000_000 },
          { name: "pipeline-generator",       latestVersion: "deadbeefcafedeadbeef", latestCreatedAt: 1_700_000_001_000 },
        ],
      }),
    });
    render(<PipelinesPage />);
    await waitFor(() => {
      expect(screen.getByText("pr-description-generator")).toBeDefined();
      expect(screen.getByText("pipeline-generator")).toBeDefined();
    });
    const link = screen.getByRole("link", { name: /pr-description-generator/i }) as HTMLAnchorElement;
    expect(link.getAttribute("href")).toBe("/kernel-next/pipelines/pr-description-generator");
  });
});
