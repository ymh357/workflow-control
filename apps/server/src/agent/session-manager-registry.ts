import { SessionManager, type SessionManagerConfig } from "./session-manager.js";

const managers = new Map<string, SessionManager>();

export function getOrCreateSessionManager(taskId: string, config: SessionManagerConfig): SessionManager {
  const existing = managers.get(taskId);
  if (existing) return existing;

  const mgr = new SessionManager(config);
  managers.set(taskId, mgr);
  return mgr;
}

export function getSessionManager(taskId: string): SessionManager | undefined {
  return managers.get(taskId);
}

export function closeSessionManager(taskId: string): void {
  const mgr = managers.get(taskId);
  if (mgr) {
    mgr.close();
    managers.delete(taskId);
  }
}

export function closeAllSessionManagers(): void {
  for (const [, mgr] of managers) {
    mgr.close();
  }
  managers.clear();
}
