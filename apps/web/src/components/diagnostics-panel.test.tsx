import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { DiagnosticsPanel } from "./diagnostics-panel";

describe("DiagnosticsPanel", () => {
  it("returns null when diagnostics empty", () => {
    const { container } = render(<DiagnosticsPanel diagnostics={[]} />);
    expect(container).toBeEmptyDOMElement();
  });

  it("groups diagnostics by code with count", () => {
    render(
      <DiagnosticsPanel
        diagnostics={[
          { code: "STORE_SCHEMA_STAGE_MISSING", message: "stage x" },
          { code: "STORE_SCHEMA_STAGE_MISSING", message: "stage y" },
          { code: "PORT_MISSING", message: "p1" },
        ]}
      />,
    );
    expect(screen.getByText(/STORE_SCHEMA_STAGE_MISSING \(2\)/)).toBeInTheDocument();
    expect(screen.getByText(/PORT_MISSING \(1\)/)).toBeInTheDocument();
  });

  it("shows all messages under their code group", () => {
    render(
      <DiagnosticsPanel
        diagnostics={[
          { code: "X", message: "msg-1" },
          { code: "X", message: "msg-2" },
        ]}
      />,
    );
    expect(screen.getByText("msg-1")).toBeInTheDocument();
    expect(screen.getByText("msg-2")).toBeInTheDocument();
  });

  it("exposes a copy-to-clipboard button", () => {
    render(<DiagnosticsPanel diagnostics={[{ code: "X", message: "y" }]} />);
    expect(screen.getByRole("button", { name: /copy/i })).toBeInTheDocument();
  });

  it("shows diagnostics count in header", () => {
    render(
      <DiagnosticsPanel
        diagnostics={[
          { code: "A", message: "1" },
          { code: "B", message: "2" },
          { code: "C", message: "3" },
        ]}
      />,
    );
    expect(screen.getByText(/Diagnostics \(3\)/)).toBeInTheDocument();
  });
});
