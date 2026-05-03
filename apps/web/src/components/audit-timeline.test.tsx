import { render as rawRender, screen } from "@testing-library/react";
import { describe, it, expect } from "vitest";
import "@testing-library/jest-dom/vitest";
import { ReactNode } from "react";
import { AuditTimeline } from "./audit-timeline";
import { ToastProvider } from "./toast";

// 2026-05-03: AuditTimeline now exposes a Rollback button which calls
// useToast for success/error feedback, so every test must mount it
// inside ToastProvider. The wrapper preserves the existing assertions —
// none of the legacy tests pass `showRollback`, so the button never
// renders and the toast hook is exercised only via mount.
const render = (ui: ReactNode) => rawRender(<ToastProvider>{ui}</ToastProvider>);

describe("AuditTimeline", () => {
  it("returns null when entries empty", () => {
    render(<AuditTimeline entries={[]} />);
    // The component returns null; assert no <section> renders.
    // (The ambient ToastProvider injects a fixed container which is
    // unrelated to AuditTimeline's output.)
    expect(screen.queryByRole("region")).not.toBeInTheDocument();
    expect(screen.queryByText(/Hot-update audit/i)).not.toBeInTheDocument();
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

  // 2026-05-03: Rollback button surfaces only on success migrate entries
  // when the parent opts in via showRollback + taskId. Other kinds and
  // omitted props leave the button hidden.
  it("renders Rollback button when showRollback + taskId are set on a migrate entry", () => {
    render(
      <AuditTimeline
        taskId="t1"
        showRollback
        entries={[
          {
            event_id: "e1",
            kind: "migrate",
            actor: "user",
            timestamp: 0,
            from_version: "vvvvvvvv1111",
            to_version: "wwwwwwww2222",
          },
        ]}
      />,
    );
    expect(screen.getByRole("button", { name: /Roll back/i })).toBeInTheDocument();
  });

  it("hides Rollback button on rollback entries (cannot un-rollback)", () => {
    render(
      <AuditTimeline
        taskId="t1"
        showRollback
        entries={[
          {
            event_id: "e1",
            kind: "rollback",
            actor: "user",
            timestamp: 0,
            from_version: "vvvvvvvv1111",
            to_version: "wwwwwwww2222",
          },
        ]}
      />,
    );
    expect(screen.queryByRole("button", { name: /Roll back/i })).not.toBeInTheDocument();
  });

  it("hides Rollback button on migrate_failed entries (auto-reverse already ran)", () => {
    render(
      <AuditTimeline
        taskId="t1"
        showRollback
        entries={[
          {
            event_id: "e1",
            kind: "migrate_failed",
            actor: "user",
            timestamp: 0,
            from_version: "vvvvvvvv1111",
            to_version: "wwwwwwww2222",
          },
        ]}
      />,
    );
    expect(screen.queryByRole("button", { name: /Roll back/i })).not.toBeInTheDocument();
  });

  it("hides Rollback button when showRollback is omitted", () => {
    render(
      <AuditTimeline
        taskId="t1"
        entries={[
          {
            event_id: "e1",
            kind: "migrate",
            actor: "user",
            timestamp: 0,
            from_version: "vvvvvvvv1111",
            to_version: "wwwwwwww2222",
          },
        ]}
      />,
    );
    expect(screen.queryByRole("button", { name: /Roll back/i })).not.toBeInTheDocument();
  });

  it("hides Rollback button when from_version equals to_version (no diff)", () => {
    render(
      <AuditTimeline
        taskId="t1"
        showRollback
        entries={[
          {
            event_id: "e1",
            kind: "migrate",
            actor: "user",
            timestamp: 0,
            from_version: "samesamesame",
            to_version: "samesamesame",
          },
        ]}
      />,
    );
    expect(screen.queryByRole("button", { name: /Roll back/i })).not.toBeInTheDocument();
  });
});
