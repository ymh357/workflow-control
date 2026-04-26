"use client";

import { useCallback, useEffect, useState } from "react";

const ARCHIVE_LS_KEY = "wfctl-archived-tasks";

const readArchive = (): Set<string> => {
  if (typeof window === "undefined") return new Set();
  try {
    const raw = window.localStorage.getItem(ARCHIVE_LS_KEY);
    if (!raw) return new Set();
    const parsed = JSON.parse(raw) as unknown;
    if (Array.isArray(parsed)) return new Set(parsed.filter((v): v is string => typeof v === "string"));
    return new Set();
  } catch {
    return new Set();
  }
};

const writeArchive = (set: Set<string>): void => {
  if (typeof window === "undefined") return;
  try { window.localStorage.setItem(ARCHIVE_LS_KEY, JSON.stringify(Array.from(set))); }
  catch { /* storage unavailable */ }
};

/**
 * Soft-archive task IDs in localStorage. Backend isn't aware — the
 * server already auto-cleans data older than 7 days via cleanupOldData,
 * so unbounded growth isn't a real risk; this is purely a UI
 * "mute these from my view" affordance.
 *
 * 2026-04-27 B-secondary.
 */
export const useArchivedTasks = (): {
  isArchived: (taskId: string) => boolean;
  archive: (taskId: string) => void;
  unarchive: (taskId: string) => void;
  archivedCount: number;
  clearAll: () => void;
} => {
  const [set, setSet] = useState<Set<string>>(() => new Set());

  useEffect(() => {
    setSet(readArchive());
  }, []);

  const archive = useCallback((taskId: string): void => {
    setSet((prev) => {
      if (prev.has(taskId)) return prev;
      const next = new Set(prev);
      next.add(taskId);
      writeArchive(next);
      return next;
    });
  }, []);

  const unarchive = useCallback((taskId: string): void => {
    setSet((prev) => {
      if (!prev.has(taskId)) return prev;
      const next = new Set(prev);
      next.delete(taskId);
      writeArchive(next);
      return next;
    });
  }, []);

  const clearAll = useCallback((): void => {
    setSet(new Set());
    writeArchive(new Set());
  }, []);

  const isArchived = useCallback((taskId: string): boolean => set.has(taskId), [set]);

  return { isArchived, archive, unarchive, archivedCount: set.size, clearAll };
};
