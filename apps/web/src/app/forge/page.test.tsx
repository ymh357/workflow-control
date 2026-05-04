import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), back: vi.fn() }),
}));

import ForgePage from "./page";

const originalFetch = globalThis.fetch;

beforeEach(() => {
  globalThis.fetch = vi.fn() as unknown as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("ForgePage", () => {
  it("renders the Forge Now button and a session input", () => {
    render(<ForgePage />);
    expect(screen.getByRole("button", { name: /forge now/i })).toBeInTheDocument();
    expect(screen.getByPlaceholderText(/Session ID/i)).toBeInTheDocument();
  });

  it("renders a use-existing recommendation after analyze", async () => {
    (globalThis.fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ok: true, status: 200,
      json: async () => ({
        kind: "use-existing",
        sessionId: "s1", jsonlPath: "/x.jsonl", cwd: "/x",
        episodeCount: 1,
        episodes: [{
          episodeId: "e1",
          intent: "extract changelog",
          outcome: "completed",
          pipelineAble: true,
          rationale: "structured",
          steps: [{ stageKind: "agent", description: "scan" }],
        }],
        truncated: false,
        embeddingModel: "local-hash-v1",
        recommendation: {
          pipelineName: "changelog-extractor",
          versionHash: "abc1234",
          cosine: 0.91,
          why: "matches cleanly",
          runUrl: "/kernel-next/pipelines/changelog-extractor",
        },
        alternatives: [],
      }),
    } as unknown as Response);

    render(<ForgePage />);
    fireEvent.click(screen.getByRole("button", { name: /forge now/i }));
    await waitFor(() => {
      expect(screen.getByText(/use existing pipeline/i)).toBeInTheDocument();
      expect(screen.getByText("changelog-extractor")).toBeInTheDocument();
      expect(screen.getByText(/matches cleanly/)).toBeInTheDocument();
    });
  });

  it("renders a create-new proposal after analyze", async () => {
    (globalThis.fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ok: true, status: 200,
      json: async () => ({
        kind: "create-new",
        sessionId: "s1", jsonlPath: "/x.jsonl", cwd: "/x",
        episodeCount: 1,
        episodes: [],
        truncated: false,
        embeddingModel: "local-hash-v1",
        proposal: {
          suggestedName: "summarize-pr",
          intent: "summarize a PR",
          description: "stuff",
          pipelineGeneratorPrompt: "Build a pipeline named 'summarize-pr' …",
          suggestedExternalInputs: [
            { name: "pr_number", type: "string", description: "the PR number" },
          ],
          nearestExisting: [],
          whyNotExisting: "no similar pipeline",
        },
      }),
    } as unknown as Response);

    render(<ForgePage />);
    fireEvent.click(screen.getByRole("button", { name: /forge now/i }));
    await waitFor(() => {
      expect(screen.getByText(/create a new pipeline/i)).toBeInTheDocument();
      expect(screen.getByText("summarize-pr")).toBeInTheDocument();
      expect(screen.getByText(/Build a pipeline named/)).toBeInTheDocument();
      expect(screen.getByText(/the PR number/)).toBeInTheDocument();
    });
  });

  it("renders a no-pattern message when nothing is detected", async () => {
    (globalThis.fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ok: true, status: 200,
      json: async () => ({
        kind: "no-pattern",
        sessionId: "s1", jsonlPath: "/x.jsonl", cwd: "/x",
        episodeCount: 0,
        episodes: [],
        truncated: false,
        embeddingModel: "local-hash-v1",
        reason: "session was too short",
      }),
    } as unknown as Response);

    render(<ForgePage />);
    fireEvent.click(screen.getByRole("button", { name: /forge now/i }));
    await waitFor(() => {
      expect(screen.getByText(/No automatable pattern detected/i)).toBeInTheDocument();
      expect(screen.getByText(/session was too short/)).toBeInTheDocument();
    });
  });

  it("renders error state for an error response", async () => {
    (globalThis.fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ok: false, status: 400,
      json: async () => ({
        kind: "error",
        code: "DISTILL_TIMEOUT",
        message: "took too long",
      }),
    } as unknown as Response);

    render(<ForgePage />);
    fireEvent.click(screen.getByRole("button", { name: /forge now/i }));
    await waitFor(() => {
      expect(screen.getByText(/Analysis failed/)).toBeInTheDocument();
      expect(screen.getByText(/DISTILL_TIMEOUT/)).toBeInTheDocument();
    });
  });

  it("sends jsonlPath when input looks like a file path", async () => {
    const fakeFetch = vi.fn().mockResolvedValueOnce({
      ok: true, status: 200,
      json: async () => ({
        kind: "no-pattern",
        sessionId: "s1", jsonlPath: "/foo/bar.jsonl", cwd: "/foo", episodeCount: 0,
        episodes: [], truncated: false, embeddingModel: "x", reason: "noop",
      }),
    });
    globalThis.fetch = fakeFetch as unknown as typeof fetch;
    render(<ForgePage />);
    fireEvent.change(screen.getByPlaceholderText(/Session ID/i), {
      target: { value: "/abs/path/to/session.jsonl" },
    });
    fireEvent.click(screen.getByRole("button", { name: /forge now/i }));
    await waitFor(() => expect(fakeFetch).toHaveBeenCalled());
    const callArgs = fakeFetch.mock.calls[0]!;
    const body = JSON.parse((callArgs[1] as { body: string }).body);
    expect(body).toEqual({ jsonlPath: "/abs/path/to/session.jsonl" });
  });

  it("sends sessionId when input does not look like a file path", async () => {
    const fakeFetch = vi.fn().mockResolvedValueOnce({
      ok: true, status: 200,
      json: async () => ({
        kind: "no-pattern",
        sessionId: "abc-123", jsonlPath: "/x", cwd: "/x", episodeCount: 0,
        episodes: [], truncated: false, embeddingModel: "x", reason: "n",
      }),
    });
    globalThis.fetch = fakeFetch as unknown as typeof fetch;
    render(<ForgePage />);
    fireEvent.change(screen.getByPlaceholderText(/Session ID/i), {
      target: { value: "abc-123-uuid" },
    });
    fireEvent.click(screen.getByRole("button", { name: /forge now/i }));
    await waitFor(() => expect(fakeFetch).toHaveBeenCalled());
    const body = JSON.parse((fakeFetch.mock.calls[0]![1] as { body: string }).body);
    expect(body).toEqual({ sessionId: "abc-123-uuid" });
  });
});
