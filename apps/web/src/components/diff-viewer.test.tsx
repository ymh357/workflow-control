import { render, screen } from "@testing-library/react";
import { describe, it, expect } from "vitest";
import "@testing-library/jest-dom/vitest";
import { DiffViewer } from "./diff-viewer";

describe("DiffViewer", () => {
  it("shows 'no diff' message when diff is empty string", () => {
    render(<DiffViewer diff="" />);
    expect(screen.getByText(/no diff/i)).toBeInTheDocument();
  });

  it("shows 'no diff' message when diff is whitespace only", () => {
    render(<DiffViewer diff="   " />);
    expect(screen.getByText(/no diff/i)).toBeInTheDocument();
  });

  it("renders each line of the diff", () => {
    render(<DiffViewer diff={"+added\n-removed\n@@ chunk @@"} />);
    expect(screen.getByText("+added")).toBeInTheDocument();
    expect(screen.getByText("-removed")).toBeInTheDocument();
    expect(screen.getByText("@@ chunk @@")).toBeInTheDocument();
  });

  it("renders SHA badges truncated to 8 chars when provided", () => {
    render(
      <DiffViewer
        diff="+x"
        beforeSha="abcdefgh1234567890"
        afterSha="zyxwvuts9876543210"
      />,
    );
    expect(screen.getByText("abcdefgh")).toBeInTheDocument();
    expect(screen.getByText("zyxwvuts")).toBeInTheDocument();
  });

  it("does not render SHA section when both SHAs are absent", () => {
    const { container } = render(<DiffViewer diff="+x" />);
    // No code elements for SHA display
    expect(container.querySelectorAll("code")).toHaveLength(0);
  });

  it("shows status-specific message for empty diff when status provided", () => {
    render(<DiffViewer diff="" status="capturing" />);
    expect(screen.getByText(/still capturing/i)).toBeInTheDocument();
  });

  it("shows 'not a git repository' message for not_a_repo status", () => {
    render(<DiffViewer diff="" status="not_a_repo" />);
    expect(screen.getByText(/not a git repository/i)).toBeInTheDocument();
  });

  it("shows 'diff too large' message for diff_too_large status", () => {
    render(<DiffViewer diff="" status="diff_too_large" />);
    expect(screen.getByText(/exceeded size cap/i)).toBeInTheDocument();
  });

  it("falls back to default message for unknown status value", () => {
    render(<DiffViewer diff="" status="mystery" />);
    expect(screen.getByText(/no diff/i)).toBeInTheDocument();
  });
});
