"use client";

import { useKeyboardShortcuts } from "../hooks/use-keyboard-shortcuts";

/**
 * Mounts the global keyboard handler and renders the "?" help overlay.
 * Drop into the app shell (layout.tsx) once.
 *
 * 2026-04-27 B-secondary.
 */
export const KeyboardShortcutsOverlay = (): React.ReactElement | null => {
  const { helpOpen, closeHelp } = useKeyboardShortcuts();
  if (!helpOpen) return null;

  const Row = ({ keys, label }: { keys: string; label: string }): React.ReactElement => (
    <li className="flex items-baseline justify-between gap-4 py-1">
      <span className="text-sm text-primary">{label}</span>
      <kbd className="rounded border border-strong bg-page px-1.5 py-0.5 font-mono text-xs text-secondary">
        {keys}
      </kbd>
    </li>
  );

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="kbd-help-title"
      className="fixed inset-0 z-[10000] flex items-center justify-center bg-black/60 px-4"
      onClick={closeHelp}
    >
      <div
        className="w-full max-w-md rounded-lg border border-strong bg-surface p-5 shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="flex items-baseline justify-between">
          <h2 id="kbd-help-title" className="text-base font-semibold text-primary">
            Keyboard shortcuts
          </h2>
          <button
            type="button"
            onClick={closeHelp}
            aria-label="Close shortcut help"
            className="rounded text-secondary hover:text-primary"
          >
            ✕
          </button>
        </header>
        <ul className="mt-4 divide-y divide-default">
          <Row label="Focus search" keys="/" />
          <Row label="Go to launcher" keys="g l" />
          <Row label="Go to tasks" keys="g t" />
          <Row label="Go to pipelines" keys="g p" />
          <Row label="Go to proposals" keys="g r" />
          <Row label="Toggle this help" keys="?" />
          <Row label="Close any dialog" keys="Esc" />
        </ul>
        <p className="mt-3 text-xs text-muted">
          Shortcuts are inert while typing in inputs / textareas.
        </p>
      </div>
    </div>
  );
};
