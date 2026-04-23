import { render, screen } from "@testing-library/react";
import { describe, it, expect } from "vitest";
import "@testing-library/jest-dom/vitest";
import { AuditTimeline } from "./audit-timeline";

describe("AuditTimeline", () => {
  it("returns null when entries empty", () => {
    const { container } = render(<AuditTimeline entries={[]} />);
    expect(container).toBeEmptyDOMElement();
  });

  it("renders one listitem per audit entry", () => {
    render(
      <AuditTimeline
        entries={[
          { event_id: "e1", kind: "migrate", actor: "user", timestamp: 1000 },
          { event_id: "e2", kind: "rollback", actor: "user", timestamp: 2000 },
          { event_id: "e3", kind: "migrate_failed", actor: "claude", timestamp: 3000 },
        ]}
      />,
    );
    expect(screen.getAllByRole("listitem")).toHaveLength(3);
  });

  it("shows kind badge for each event", () => {
    render(
      <AuditTimeline
        entries={[
          { event_id: "e", kind: "rollback", actor: "user", timestamp: 0 },
        ]}
      />,
    );
    expect(screen.getByText(/rollback/i)).toBeInTheDocument();
  });

  it("renders migrate-failed label for migrate_failed kind", () => {
    render(
      <AuditTimeline
        entries={[
          { event_id: "e", kind: "migrate_failed", actor: "user", timestamp: 0 },
        ]}
      />,
    );
    expect(screen.getByText(/migrate-failed/i)).toBeInTheDocument();
  });

  it("renders version hashes truncated to 8 chars when from+to present", () => {
    render(
      <AuditTimeline
        entries={[
          {
            event_id: "e",
            kind: "migrate",
            actor: "user",
            timestamp: 0,
            from_version: "abcdefgh9999",
            to_version: "ijklmnop0000",
          },
        ]}
      />,
    );
    expect(screen.getByText("abcdefgh")).toBeInTheDocument();
    expect(screen.getByText("ijklmnop")).toBeInTheDocument();
  });

  it("shows entry count in header", () => {
    render(
      <AuditTimeline
        entries={[
          { event_id: "e1", kind: "migrate", actor: "user", timestamp: 0 },
          { event_id: "e2", kind: "rollback", actor: "user", timestamp: 0 },
        ]}
      />,
    );
    expect(screen.getByText(/audit \(2\)/i)).toBeInTheDocument();
  });

  it("shows actor for each entry", () => {
    render(
      <AuditTimeline
        entries={[
          { event_id: "e", kind: "migrate", actor: "claude-ai", timestamp: 0 },
        ]}
      />,
    );
    expect(screen.getByText("claude-ai")).toBeInTheDocument();
  });

  it("shows proposal_status badge when present", () => {
    render(
      <AuditTimeline
        entries={[
          {
            event_id: "e",
            kind: "migrate",
            actor: "user",
            timestamp: 0,
            proposal_status: "approved",
          },
        ]}
      />,
    );
    expect(screen.getByText(/proposal: approved/i)).toBeInTheDocument();
  });

  it("does not render version row when from_version or to_version is absent", () => {
    render(
      <AuditTimeline
        entries={[
          { event_id: "e", kind: "rollback", actor: "user", timestamp: 0, from_version: "abc" },
        ]}
      />,
    );
    // Only from_version set — to_version absent → version span should not render
    expect(screen.queryByText("abc")).not.toBeInTheDocument();
  });
});
