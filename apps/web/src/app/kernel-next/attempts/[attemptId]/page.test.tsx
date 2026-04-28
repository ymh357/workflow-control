import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import AttemptDetailsPage from "./page";

// Mock useParams — the page reads attemptId out of the dynamic route.
vi.mock("next/navigation", () => ({
  useParams: () => ({ attemptId: "test-attempt-0123456789" }),
}));

describe("AttemptDetailsPage", () => {
  const origFetch = global.fetch;

  beforeEach(() => {
    global.fetch = vi.fn(async () =>
      new Response(
        JSON.stringify({
          ok: true,
          details: {
            toolCalls: [{ name: "write_port", input: {} }],
            agentStream: [
              { type: "text", text: "hello" },
              { type: "thinking", text: "hmm" },
              { type: "thinking", text: "more" },
              // Bug 11 (2026-04-28) — SDK stderr lines must NOT bleed into
              // the messages tab; their own tab keeps them auditable.
              { type: "sdk_stderr", text: "Connection failed after 1234ms" },
            ],
            compactEvents: [],
            subAgents: [],
            statusHistory: [
              { status: "success", startedAt: 1000, endedAt: 1800 },
            ],
            costUsd: 0.05,
            inputTokens: 100,
            outputTokens: 50,
            sessionId: "sess-123",
            model: "claude-sonnet-4",
            durationMs: 800,
            startedAt: 1000,
            endedAt: 1800,
            terminationReason: "natural_completion",
          },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    ) as unknown as typeof fetch;
  });

  afterEach(() => {
    global.fetch = origFetch;
  });

  it("renders tab bar with counts partitioned by stream type", async () => {
    render(<AttemptDetailsPage />);
    // Messages = text-only agentStream entries = 1 (the sdk_stderr entry
    // must NOT count here, otherwise the assistant transcript drowns in
    // diagnostics — see Bug 11);
    // Thinking = thinking entries = 2;
    // SDK Stderr = sdk_stderr entries = 1.
    expect(await screen.findByText(/Tool Calls \(1\)/)).toBeInTheDocument();
    expect(await screen.findByText(/Messages \(1\)/)).toBeInTheDocument();
    expect(await screen.findByText(/Thinking \(2\)/)).toBeInTheDocument();
    expect(await screen.findByText(/SDK Stderr \(1\)/)).toBeInTheDocument();
    expect(await screen.findByText(/Status Timeline \(1\)/)).toBeInTheDocument();
  });

  it("shows session id + model + usage summary when present", async () => {
    render(<AttemptDetailsPage />);
    expect(await screen.findByText(/sess-123/)).toBeInTheDocument();
    expect(await screen.findByText(/claude-sonnet-4/)).toBeInTheDocument();
    expect(await screen.findByText(/\$0\.0500/)).toBeInTheDocument();
    // Tokens — use a regex tolerant of the locale-inserted comma.
    expect(await screen.findByText(/Input tokens:/)).toBeInTheDocument();
  });
});
