"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";

/**
 * Global keyboard shortcuts for the dashboard. Mirrors GitHub-style "g
 * <letter>" navigation patterns plus a single-key shortcut for search
 * focus and a "?" overlay listing every binding.
 *
 * Bindings:
 *   /      → focus the first <input type="search"> on the page
 *   g l    → /                              (Launcher)
 *   g t    → /kernel-next                   (Tasks)
 *   g p    → /kernel-next/pipelines         (Pipelines)
 *   g r    → /kernel-next/proposals         (pRoposals)
 *   ?      → toggle the help overlay
 *   Esc    → close the help overlay (if open)
 *
 * The handler is intentionally inert when the user is typing in an
 * INPUT/TEXTAREA/CONTENTEDITABLE element so prefix shortcuts don't
 * hijack normal text entry.
 *
 * 2026-04-27 B-secondary.
 */
export const useKeyboardShortcuts = (): { helpOpen: boolean; closeHelp: () => void } => {
  const router = useRouter();
  const [helpOpen, setHelpOpen] = useState(false);

  useEffect(() => {
    let prefixActive = false;
    let prefixTimer: ReturnType<typeof setTimeout> | null = null;

    const isTextInput = (el: EventTarget | null): boolean => {
      if (!(el instanceof HTMLElement)) return false;
      if (el.isContentEditable) return true;
      const tag = el.tagName;
      if (tag === "INPUT") {
        const type = (el as HTMLInputElement).type;
        // Allow "/" focus for search inputs, but otherwise treat input
        // as text entry that swallows shortcuts.
        return type !== "checkbox" && type !== "radio" && type !== "button";
      }
      return tag === "TEXTAREA" || tag === "SELECT";
    };

    const handler = (e: KeyboardEvent): void => {
      // Modifier-bearing shortcuts are reserved for the browser/OS.
      if (e.ctrlKey || e.metaKey || e.altKey) return;

      // Esc closes help even from inside a text input.
      if (e.key === "Escape" && helpOpen) {
        e.preventDefault();
        setHelpOpen(false);
        return;
      }

      if (isTextInput(e.target)) return;

      // "/" focuses the first search input on the page.
      if (e.key === "/") {
        const search = document.querySelector<HTMLInputElement>('input[type="search"]');
        if (search) {
          e.preventDefault();
          search.focus();
          search.select();
        }
        return;
      }

      // "?" toggles help overlay.
      if (e.key === "?" || (e.shiftKey && e.key === "/")) {
        e.preventDefault();
        setHelpOpen((v) => !v);
        return;
      }

      // "g" prefix arms a 1.2s window for one of t/p/r/l.
      if (!prefixActive && e.key === "g") {
        e.preventDefault();
        prefixActive = true;
        if (prefixTimer) clearTimeout(prefixTimer);
        prefixTimer = setTimeout(() => { prefixActive = false; }, 1200);
        return;
      }
      if (prefixActive) {
        prefixActive = false;
        if (prefixTimer) clearTimeout(prefixTimer);
        const target =
          e.key === "l" ? "/"
          : e.key === "t" ? "/kernel-next"
          : e.key === "p" ? "/kernel-next/pipelines"
          : e.key === "r" ? "/kernel-next/proposals"
          : null;
        if (target) {
          e.preventDefault();
          router.push(target);
        }
      }
    };

    window.addEventListener("keydown", handler);
    return () => {
      window.removeEventListener("keydown", handler);
      if (prefixTimer) clearTimeout(prefixTimer);
    };
  }, [router, helpOpen]);

  return { helpOpen, closeHelp: () => setHelpOpen(false) };
};
