"use client";

import { useEffect, useRef } from "react";

interface ConfirmDialogProps {
  open: boolean;
  title: string;
  message: string;
  confirmLabel?: string;
  cancelLabel?: string;
  destructive?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

/**
 * Lightweight confirm dialog used before destructive actions (cancel
 * task, reject proposal, etc.). Built without a portal so it stays
 * scoped to the React tree; uses fixed positioning to overlay the page.
 * Esc dismisses; Enter confirms.
 *
 * 2026-04-27 B3/B7.
 */
export const ConfirmDialog = ({
  open,
  title,
  message,
  confirmLabel = "Confirm",
  cancelLabel = "Cancel",
  destructive = false,
  onConfirm,
  onCancel,
}: ConfirmDialogProps) => {
  const confirmRef = useRef<HTMLButtonElement>(null);

  // B7.F12 (2026-04-30 review): onCancel/onConfirm in the deps array
  // re-created the keydown listener AND re-focused the confirm
  // button on every parent re-render — focus jumped away from any
  // input the user was typing into. Latest-callback ref pattern:
  // listener captures `latest` once, callbacks are read at call
  // time so updates land without re-running the effect.
  const latest = useRef({ onCancel, onConfirm });
  latest.current = { onCancel, onConfirm };

  useEffect(() => {
    if (!open) return;
    const handler = (e: KeyboardEvent): void => {
      if (e.key === "Escape") latest.current.onCancel();
      else if (e.key === "Enter" && document.activeElement?.tagName !== "TEXTAREA") {
        latest.current.onConfirm();
      }
    };
    window.addEventListener("keydown", handler);
    confirmRef.current?.focus();
    return () => window.removeEventListener("keydown", handler);
  }, [open]);

  if (!open) return null;

  // B7.F11 (2026-04-30 review): pre-fix the overlay had a bare
  // onClick={onCancel}. A user starting mousedown inside the dialog
  // (e.g. selecting text) and dragging to overlay before mouseup
  // would fire `click` on the overlay → close. Track the mousedown
  // target instead: only close when BOTH mousedown and mouseup were
  // on the overlay.
  const overlayMouseDown = useRef(false);
  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="confirm-dialog-title"
      className="fixed inset-0 z-[10000] flex items-center justify-center bg-black/60 px-4"
      onMouseDown={(e) => {
        overlayMouseDown.current = e.target === e.currentTarget;
      }}
      onClick={(e) => {
        if (overlayMouseDown.current && e.target === e.currentTarget) {
          onCancel();
        }
        overlayMouseDown.current = false;
      }}
    >
      <div
        className="w-full max-w-md rounded-lg border border-strong bg-surface p-5 shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 id="confirm-dialog-title" className="text-base font-semibold text-primary">
          {title}
        </h2>
        <p className="mt-2 text-sm text-secondary">{message}</p>
        <div className="mt-4 flex justify-end gap-2">
          <button
            type="button"
            onClick={onCancel}
            className="rounded border border-strong bg-elevated px-3 py-1.5 text-sm text-primary hover:border-strong hover:bg-elevated"
          >
            {cancelLabel}
          </button>
          <button
            ref={confirmRef}
            type="button"
            onClick={onConfirm}
            className={
              destructive
                ? "rounded border border-danger-border bg-danger-bg px-3 py-1.5 text-sm font-semibold text-danger-fg hover:border-danger-border hover:bg-elevated"
                : "rounded border border-info-border bg-accent px-3 py-1.5 text-sm font-semibold text-white hover:bg-accent-hover"
            }
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
};
