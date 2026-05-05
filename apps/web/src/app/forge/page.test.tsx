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

interface FakeRec {
  kind: "use-existing" | "create-new";
  episode: { episodeId: string; intent: string; outcome: string; pipelineAble: boolean; rationale: string; steps: Array<{ stageKind: string; description: string }> };
  pipelineName?: string;
  versionHash?: string;
  cosine?: number;
  why?: string;
  runUrl?: string;
  alternatives?: unknown[];
  proposal?: {
    suggestedName: string;
    intent: string;
    pipelineGeneratorPrompt: string;
    suggestedExternalInputs: Array<{ name: string; type: string; description: string }>;
    nearestExisting: unknown[];
    whyNotExisting: string;
  };
}

function fakeOk(recommendations: FakeRec[], skipped: Array<{ episode: FakeRec["episode"]; reason: string }> = []) {
  const useExistingCount = recommendations.filter((r) => r.kind === "use-existing").length;
  const createNewCount = recommendations.filter((r) => r.kind === "create-new").length;
  return {
    kind: "ok",
    sessionId: "s1", jsonlPath: "/x.jsonl", cwd: "-x", projectDirEncoded: true,
    episodeCount: recommendations.length + skipped.length,
    truncated: false,
    embeddingModel: "local-hash-v1",
    recommendations,
    skippedEpisodes: skipped,
    summary: { useExistingCount, createNewCount, skippedCount: skipped.length },
  };
}

function ep(intent: string, id = "e" + Math.random()) {
  return {
    episodeId: id, intent, outcome: "completed", pipelineAble: true, rationale: "r",
    steps: [{ stageKind: "agent", description: "scan" }],
  };
}

describe("ForgePage", () => {
  it("renders the Forge Now button and a session input", () => {
    render(<ForgePage />);
    expect(screen.getByRole("button", { name: /forge now/i })).toBeInTheDocument();
    expect(screen.getByPlaceholderText(/Session ID/i)).toBeInTheDocument();
  });

  it("renders MULTIPLE recommendation cards (multi-episode)", async () => {
    (globalThis.fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ok: true, status: 200,
      json: async () => fakeOk([
        {
          kind: "use-existing",
          episode: ep("extract changelog", "e1"),
          pipelineName: "changelog-extractor",
          versionHash: "abc123", cosine: 0.91,
          why: "matches cleanly",
          runUrl: "/kernel-next/pipelines/changelog-extractor",
          alternatives: [],
        },
        {
          kind: "create-new",
          episode: ep("summarize a PR", "e2"),
          proposal: {
            suggestedName: "summarize-pr",
            intent: "summarize a PR",
            pipelineGeneratorPrompt: "Build a pipeline named 'summarize-pr' …",
            suggestedExternalInputs: [{ name: "pr", type: "string", description: "the PR" }],
            nearestExisting: [],
            whyNotExisting: "no similar pipeline",
          },
        },
        {
          kind: "create-new",
          episode: ep("rebuild docker image", "e3"),
          proposal: {
            suggestedName: "rebuild-docker-image",
            intent: "rebuild docker image",
            pipelineGeneratorPrompt: "Build a pipeline named 'rebuild-docker-image' …",
            suggestedExternalInputs: [],
            nearestExisting: [],
            whyNotExisting: "fresh task",
          },
        },
      ]),
    } as unknown as Response);

    render(<ForgePage />);
    fireEvent.click(screen.getByRole("button", { name: /forge now/i }));
    await waitFor(() => {
      expect(screen.getByText("changelog-extractor")).toBeInTheDocument();
      expect(screen.getByText("summarize-pr")).toBeInTheDocument();
      expect(screen.getByText("rebuild-docker-image")).toBeInTheDocument();
    });
    expect(screen.getByText(/1 can run an existing pipeline/)).toBeInTheDocument();
    expect(screen.getByText(/2 would need a new pipeline/)).toBeInTheDocument();
  });

  it("renders use-existing recommendation card", async () => {
    (globalThis.fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ok: true, status: 200,
      json: async () => fakeOk([{
        kind: "use-existing",
        episode: ep("extract changelog", "e1"),
        pipelineName: "changelog-extractor",
        versionHash: "abc123", cosine: 0.91,
        why: "matches cleanly",
        runUrl: "/kernel-next/pipelines/changelog-extractor",
        alternatives: [],
      }]),
    } as unknown as Response);

    render(<ForgePage />);
    fireEvent.click(screen.getByRole("button", { name: /forge now/i }));
    await waitFor(() => {
      expect(screen.getByText(/Use existing pipeline/i)).toBeInTheDocument();
      expect(screen.getByText("changelog-extractor")).toBeInTheDocument();
    });
  });

  it("renders create-new card with copyable prompt", async () => {
    (globalThis.fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ok: true, status: 200,
      json: async () => fakeOk([{
        kind: "create-new",
        episode: ep("summarize a PR", "e1"),
        proposal: {
          suggestedName: "summarize-pr",
          intent: "summarize a PR",
          pipelineGeneratorPrompt: "Build a pipeline named 'summarize-pr' …",
          suggestedExternalInputs: [{ name: "pr_number", type: "string", description: "the PR number" }],
          nearestExisting: [],
          whyNotExisting: "no similar pipeline",
        },
      }]),
    } as unknown as Response);

    render(<ForgePage />);
    fireEvent.click(screen.getByRole("button", { name: /forge now/i }));
    await waitFor(() => {
      expect(screen.getByText(/Create a new pipeline/i)).toBeInTheDocument();
      expect(screen.getByText("summarize-pr")).toBeInTheDocument();
      expect(screen.getByText(/Build a pipeline named/)).toBeInTheDocument();
      expect(screen.getByText(/the PR number/)).toBeInTheDocument();
    });
  });

  it("renders skipped episodes in collapsible details", async () => {
    (globalThis.fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ok: true, status: 200,
      json: async () => fakeOk(
        [],
        [
          { episode: { ...ep("debug a flaky test", "e1"), pipelineAble: false }, reason: "one-off debug" },
        ],
      ),
    } as unknown as Response);

    render(<ForgePage />);
    fireEvent.click(screen.getByRole("button", { name: /forge now/i }));
    await waitFor(() => {
      expect(screen.getByText(/All detected episodes were one-off/)).toBeInTheDocument();
      expect(screen.getByText(/1 skipped episode/)).toBeInTheDocument();
    });
  });

  it("renders no-pattern response", async () => {
    (globalThis.fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ok: true, status: 200,
      json: async () => ({
        kind: "no-pattern",
        sessionId: "s1", jsonlPath: "/x.jsonl", cwd: "-x", projectDirEncoded: true,
        episodeCount: 0, truncated: false, embeddingModel: "local-hash-v1",
        reason: "session was too short",
      }),
    } as unknown as Response);

    render(<ForgePage />);
    fireEvent.click(screen.getByRole("button", { name: /forge now/i }));
    await waitFor(() => {
      expect(screen.getByText(/No automatable pattern detected/)).toBeInTheDocument();
      expect(screen.getByText(/session was too short/)).toBeInTheDocument();
    });
  });

  it("renders error state for an error response", async () => {
    (globalThis.fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ok: false, status: 400,
      json: async () => ({
        kind: "error", code: "DISTILL_TIMEOUT", message: "took too long",
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
      json: async () => fakeOk([]),
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
      json: async () => fakeOk([]),
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
