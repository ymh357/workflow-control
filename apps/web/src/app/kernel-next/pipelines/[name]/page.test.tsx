import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import PipelineEditorPage from "./page";

vi.mock("next/navigation", () => ({
  useParams: () => ({ name: "pr-description-generator" }),
  useRouter: () => ({ push: vi.fn() }),
}));

function textareas() {
  return (screen.getAllByRole("textbox") as HTMLElement[]).filter((el) => el.tagName === "TEXTAREA") as HTMLTextAreaElement[];
}
function actorInput() {
  return (screen.getAllByRole("textbox") as HTMLElement[]).find((el) => el.tagName === "INPUT") as HTMLInputElement;
}

describe("PipelineEditorPage", () => {
  const origFetch = global.fetch;

  beforeEach(() => {
    global.fetch = vi.fn();
    try { window.localStorage.removeItem("kernelActor"); } catch { /* ignore */ }
  });
  afterEach(() => {
    global.fetch = origFetch;
  });

  it("loads pipeline, renders PromptsEditor with its prompts map", async () => {
    (global.fetch as unknown as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          ok: true,
          pipelines: [{ name: "pr-description-generator", latestVersion: "abcdef123456", latestCreatedAt: 1 }],
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          ok: true,
          ir: { name: "pr-description-generator", stages: [] },
          prompts: { "system/write-pr": "original body" },
          parentHash: null,
          createdAt: 1,
        }),
      });
    render(<PipelineEditorPage />);
    await waitFor(() => {
      expect(screen.getByText("system/write-pr")).toBeDefined();
    });
    expect(textareas()[0]!.value).toBe("original body");
  });

  it("submits POST /api/kernel/proposals with only modified refs", async () => {
    const postMock = vi.fn().mockResolvedValue({
      ok: true, status: 202,
      json: async () => ({ ok: true, proposalId: "prop-1", proposedVersion: "newhash" }),
    });
    (global.fetch as unknown as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          ok: true,
          pipelines: [{ name: "pr-description-generator", latestVersion: "abcdef123456", latestCreatedAt: 1 }],
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          ok: true,
          ir: { name: "pr-description-generator", stages: [] },
          prompts: { "system/write-pr": "original body" },
          parentHash: null,
          createdAt: 1,
        }),
      })
      .mockImplementationOnce(postMock);

    render(<PipelineEditorPage />);
    await waitFor(() => expect(screen.getByText("system/write-pr")).toBeDefined());

    fireEvent.change(textareas()[0]!, { target: { value: "fresh body" } });
    fireEvent.change(actorInput(), { target: { value: "human:ymh" } });

    fireEvent.click(screen.getByRole("button", { name: /submit proposal/i }));

    await waitFor(() => expect(postMock).toHaveBeenCalled());
    const call = postMock.mock.calls[0]!;
    const reqArg = call[0] as Request;
    expect(reqArg.url).toMatch(/\/api\/kernel\/proposals$/);
    // Request body was set when constructing the Request — pull it back.
    const reqBody = await reqArg.json();
    expect(reqBody).toEqual({
      currentVersion: "abcdef123456",
      patch: { ops: [] },
      actor: "human:ymh",
      prompts: { "system/write-pr": "fresh body" },
    });
  });
});
