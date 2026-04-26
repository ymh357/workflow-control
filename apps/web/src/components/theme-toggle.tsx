"use client";

import { useEffect, useState } from "react";

const THEME_LS_KEY = "wfctl-theme";
type Theme = "light" | "dark";

const readInitialTheme = (): Theme => {
  if (typeof window === "undefined") return "dark";
  try {
    const saved = window.localStorage.getItem(THEME_LS_KEY);
    if (saved === "light" || saved === "dark") return saved;
  } catch { /* storage unavailable */ }
  // Respect OS preference on first visit.
  if (window.matchMedia?.("(prefers-color-scheme: light)").matches) return "light";
  return "dark";
};

const applyTheme = (theme: Theme): void => {
  if (typeof document === "undefined") return;
  document.documentElement.dataset.theme = theme;
};

/**
 * Light/dark toggle that lives in the nav. Persists to localStorage and
 * applies via [data-theme="light|dark"] on <html> — the variable swaps
 * happen in globals.css.
 *
 * 2026-04-27 B-secondary.
 */
export const ThemeToggle = (): React.ReactElement => {
  const [theme, setTheme] = useState<Theme>("dark");
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    const initial = readInitialTheme();
    setTheme(initial);
    applyTheme(initial);
    setMounted(true);
  }, []);

  const toggle = (): void => {
    const next: Theme = theme === "light" ? "dark" : "light";
    setTheme(next);
    applyTheme(next);
    try { window.localStorage.setItem(THEME_LS_KEY, next); } catch { /* ignore */ }
  };

  // Avoid SSR/CSR mismatch by rendering a placeholder on first paint.
  if (!mounted) {
    return (
      <button
        type="button"
        aria-label="Theme"
        className="rounded px-2 py-1 text-xs text-zinc-500"
        disabled
      >
        ●
      </button>
    );
  }

  return (
    <button
      type="button"
      onClick={toggle}
      title={`Switch to ${theme === "light" ? "dark" : "light"} mode`}
      aria-label={`Switch to ${theme === "light" ? "dark" : "light"} mode`}
      className="rounded px-2 py-1 text-xs text-zinc-400 hover:bg-zinc-800 hover:text-zinc-200 transition-colors data-[theme=light]:hover:bg-zinc-200 data-[theme=light]:hover:text-zinc-700"
    >
      {theme === "light" ? "☀" : "☾"}
    </button>
  );
};
