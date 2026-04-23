import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import ProposalsPage from "./page";

describe("ProposalsPage", () => {
  const origFetch = global.fetch;

  beforeEach(() => {
    global.fetch = vi.fn();
  });
  afterEach(() => {
    global.fetch = origFetch;
  });

  it("renders pending / approved / rejected sections", async () => {
    (global.fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        ok: true,
        proposals: [
          { proposalId: "p-1", pipelineName: "pr-description-generator", actor: "ymh", status: "pending", createdAt: 1, baseVersion: "aa", proposedVersion: "bb", diagnosticJson: null, rerunFrom: null, migrateRunning: "none" },
          { proposalId: "p-2", pipelineName: "pipeline-generator",       actor: "ymh", status: "approved", createdAt: 2, baseVersion: "cc", proposedVersion: "dd", diagnosticJson: null, rerunFrom: null, migrateRunning: "none" },
          { proposalId: "p-3", pipelineName: "pr-description-generator", actor: "ymh", status: "rejected", createdAt: 3, baseVersion: "ee", proposedVersion: null, diagnosticJson: null, rerunFrom: null, migrateRunning: "none" },
        ],
      }),
    });
    render(<ProposalsPage />);
    await waitFor(() => expect(screen.getByText("p-1")).toBeDefined());
    expect(screen.getByText(/Pending \(1\)/i)).toBeDefined();
    expect(screen.getByText(/Approved \(1\)/i)).toBeDefined();
    expect(screen.getByText(/Rejected \(1\)/i)).toBeDefined();
  });

  it("approve button POSTs /approve and moves row from pending to approved", async () => {
    const fetchMock = global.fetch as unknown as ReturnType<typeof vi.fn>;
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        ok: true,
        proposals: [
          { proposalId: "p-1", pipelineName: "pr-description-generator", actor: "ymh", status: "pending", createdAt: 1, baseVersion: "aa", proposedVersion: "bb", diagnosticJson: null, rerunFrom: null, migrateRunning: "none" },
        ],
      }),
    });
    fetchMock.mockResolvedValueOnce({
      ok: true, status: 200,
      json: async () => ({ ok: true, proposalId: "p-1", status: "approved" }),
    });

    render(<ProposalsPage />);
    await waitFor(() => expect(screen.getByText("p-1")).toBeDefined());
    fireEvent.click(screen.getByRole("button", { name: /approve/i }));
    await waitFor(() => expect(screen.getByText(/Pending \(0\)/i)).toBeDefined());
    expect(screen.getByText(/Approved \(1\)/i)).toBeDefined();
  });
});
