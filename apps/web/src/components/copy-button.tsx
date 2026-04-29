"use client";

import { useState } from "react";

interface CopyButtonProps {
  value: string;
  label?: string;
  className?: string;
}

/**
 * Tiny clipboard button. Renders a 〈copy〉 icon (or the supplied label)
 * and flashes "copied" for 1.5s after success. Used for taskIds, attemptIds,
 * versionHashes, and other long opaque identifiers that users routinely
 * want to paste elsewhere (MCP commands, CLI, support requests).
 */
export const CopyButton = ({ value, label, className }: CopyButtonProps) => {
  const [copied, setCopied] = useState(false);

  const onClick = async (e: React.MouseEvent): Promise<void> => {
    e.preventDefault();
    e.stopPropagation();
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // navigator.clipboard may be missing in insecure contexts —
      // fall back to a hidden textarea + execCommand.
      const ta = document.createElement("textarea");
      ta.value = value;
      ta.style.position = "fixed";
      ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.select();
      try { document.execCommand("copy"); } catch { /* really nothing to do */ }
      document.body.removeChild(ta);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    }
  };

  return (
    <button
      type="button"
      onClick={onClick}
      title={copied ? "Copied" : `Copy: ${value}`}
      aria-label={copied ? "Copied" : `Copy ${label ?? "value"}`}
      className={className ?? "ml-1 inline-flex items-center rounded border border-strong bg-surface px-1.5 py-0.5 text-xs text-secondary hover:border-strong hover:text-primary focus:outline-none focus:ring-1 focus-visible:ring-strong"}
    >
      {copied ? "✓ copied" : (label ?? "copy")}
    </button>
  );
};
