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

  useEffect(() => {
    if (!open) return;
    const handler = (e: KeyboardEvent): void => {
      if (e.key === "Escape") onCancel();
      else if (e.key === "Enter" && document.activeElement?.tagName !== "TEXTAREA") onConfirm();
    };
    window.addEventListener("keydown", handler);
    confirmRef.current?.focus();
    return () => window.removeEventListener("keydown", handler);
  }, [open, onCancel, onConfirm]);

  if (!open) return null;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="confirm-dialog-title"
      className="fixed inset-0 z-[10000] flex items-center justify-center bg-black/60 px-4"
      onClick={onCancel}
    >
      <div
        className="w-full max-w-md rounded-lg border border-zinc-700 bg-zinc-900 p-5 shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 id="confirm-dialog-title" className="text-base font-semibold text-zinc-100">
          {title}
        </h2>
        <p className="mt-2 text-sm text-zinc-300">{message}</p>
        <div className="mt-4 flex justify-end gap-2">
          <button
            type="button"
            onClick={onCancel}
            className="rounded border border-zinc-700 bg-zinc-800 px-3 py-1.5 text-sm text-zinc-200 hover:border-zinc-600 hover:bg-zinc-700"
          >
            {cancelLabel}
          </button>
          <button
            ref={confirmRef}
            type="button"
            onClick={onConfirm}
            className={
              destructive
                ? "rounded border border-red-700 bg-red-800/80 px-3 py-1.5 text-sm font-semibold text-red-100 hover:border-red-500 hover:bg-red-700"
                : "rounded border border-blue-600 bg-blue-700 px-3 py-1.5 text-sm font-semibold text-white hover:bg-blue-600"
            }
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
};
