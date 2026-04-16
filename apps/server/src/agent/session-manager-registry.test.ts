import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("./session-manager.js", () => {
  const SessionManager = vi.fn(function () {
    return { close: vi.fn(), executeStage: vi.fn() };
  });
  return { SessionManager };
});

import { getOrCreateSessionManager, getSessionManager, closeSessionManager, closeAllSessionManagers } from "./session-manager-registry.js";
import { SessionManager } from "./session-manager.js";

beforeEach(() => {
  closeAllSessionManagers();
  vi.clearAllMocks();
});

describe("SessionManager Registry", () => {
  it("creates a new SessionManager on first call", () => {
    const mgr = getOrCreateSessionManager("task-1", { taskId: "task-1", claudePath: "claude", idleTimeoutMs: 7200_000, cwd: "/tmp" });
    expect(mgr).toBeDefined();
    expect(SessionManager).toHaveBeenCalledTimes(1);
  });

  it("returns same instance on subsequent calls", () => {
    const cfg = { taskId: "task-1", claudePath: "claude", idleTimeoutMs: 7200_000, cwd: "/tmp" };
    const mgr1 = getOrCreateSessionManager("task-1", cfg);
    const mgr2 = getOrCreateSessionManager("task-1", cfg);
    expect(mgr1).toBe(mgr2);
    expect(SessionManager).toHaveBeenCalledTimes(1);
  });

  it("getSessionManager returns undefined for unknown task", () => {
    expect(getSessionManager("unknown")).toBeUndefined();
  });

  it("closeSessionManager calls close and removes from registry", () => {
    const cfg = { taskId: "task-1", claudePath: "claude", idleTimeoutMs: 7200_000, cwd: "/tmp" };
    const mgr = getOrCreateSessionManager("task-1", cfg);
    closeSessionManager("task-1");
    expect(mgr.close).toHaveBeenCalled();
    expect(getSessionManager("task-1")).toBeUndefined();
  });

  it("closeSessionManager is safe for unknown task", () => {
    expect(() => closeSessionManager("unknown")).not.toThrow();
  });
});
