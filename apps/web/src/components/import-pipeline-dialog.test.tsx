import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { ImportPipelineDialog } from "./import-pipeline-dialog";

describe("ImportPipelineDialog", () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    globalThis.fetch = vi.fn() as unknown as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("renders when open", () => {
    const onClose = vi.fn();
    const onImported = vi.fn();
    render(<ImportPipelineDialog open={true} onClose={onClose} onImported={onImported} />);
    expect(screen.getByText(/import pipeline/i)).toBeInTheDocument();
    expect(screen.getByPlaceholderText(/paste pipeline export json/i)).toBeInTheDocument();
  });

  it("does not render when closed", () => {
    const onClose = vi.fn();
    const onImported = vi.fn();
    render(<ImportPipelineDialog open={false} onClose={onClose} onImported={onImported} />);
    expect(screen.queryByText(/import pipeline/i)).not.toBeInTheDocument();
  });

  it("posts pasted JSON to import endpoint and calls onImported on success", async () => {
    (globalThis.fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({
        ok: true,
        versionHash: "deadbeef".repeat(8),
        pipelineName: "imported",
        alreadyExisted: false,
      }),
    } as unknown as Response);
    const onClose = vi.fn();
    const onImported = vi.fn();
    render(<ImportPipelineDialog open={true} onClose={onClose} onImported={onImported} />);
    const ta = screen.getByPlaceholderText(/paste pipeline export json/i);
    fireEvent.change(ta, { target: { value: '{"format":"wfctl-pipeline-export/v1"}' } });
    fireEvent.click(screen.getByRole("button", { name: /^import$/i }));
    await waitFor(() => expect(onImported).toHaveBeenCalledTimes(1));
    expect(onImported).toHaveBeenCalledWith({
      versionHash: "deadbeef".repeat(8),
      pipelineName: "imported",
      alreadyExisted: false,
    });
  });

  it("renders diagnostics on failure response and stays open", async () => {
    (globalThis.fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ok: false,
      status: 400,
      json: async () => ({
        ok: false,
        diagnostics: [{ code: "PROMPT_REF_MISSING", message: "prompt 'foo' missing" }],
      }),
    } as unknown as Response);
    const onClose = vi.fn();
    const onImported = vi.fn();
    render(<ImportPipelineDialog open={true} onClose={onClose} onImported={onImported} />);
    fireEvent.change(screen.getByPlaceholderText(/paste pipeline export json/i), {
      target: { value: "{}" },
    });
    fireEvent.click(screen.getByRole("button", { name: /^import$/i }));
    await waitFor(() => {
      expect(screen.getByText(/PROMPT_REF_MISSING/)).toBeInTheDocument();
    });
    expect(onImported).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
  });

  it("disables Import button when neither file nor textarea provided", () => {
    render(
      <ImportPipelineDialog open={true} onClose={vi.fn()} onImported={vi.fn()} />,
    );
    const btn = screen.getByRole("button", { name: /^import$/i });
    expect(btn).toBeDisabled();
  });

  it("calls onClose when Cancel clicked", () => {
    const onClose = vi.fn();
    render(<ImportPipelineDialog open={true} onClose={onClose} onImported={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: /cancel/i }));
    expect(onClose).toHaveBeenCalled();
  });
});
